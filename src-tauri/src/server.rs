use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Deserializer, Map, Value};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::settings::Settings;

// a client that never completes a json value should not be able to grow its buffer forever
const MAX_BUFFER_SIZE: usize = 64 * 1024 * 1024;

#[derive(Default)]
pub struct Request {
    request_id: String,
    correlation_id: Value,

    // when echobug first heard of the request, and when the sender says it started (both epoch microseconds)
    timestamp: u64,
    started_at: Option<u64>,
    order: u64,

    method: Value,
    url: Value,
    status: Value,

    duration: Value,
    memory: Value,

    context: Value,

    messages: Vec<Value>,
    queries: Vec<Value>,
    timeline: Vec<Value>,
}

impl Request {
    pub fn summary(&self) -> Value {
        json!({
            "requestId": self.request_id,
            "correlationId": self.correlation_id,
            "timestamp": self.started_at.unwrap_or(self.timestamp),
            "startedAt": self.started_at,
            "order": self.order,
            "method": self.method,
            "url": self.url,
            "status": self.status,
            "duration": self.duration,
            "memory": self.memory,
            "messagesCount": self.messages.len(),
            "queriesCount": self.queries.len(),
            "timelineCount": self.timeline.len(),
        })
    }

    pub fn context(&self) -> &Value {
        &self.context
    }

    pub fn messages(&self) -> &[Value] {
        &self.messages
    }

    pub fn queries(&self) -> &[Value] {
        &self.queries
    }
}

#[derive(Default)]
pub struct Store {
    requests: HashMap<String, Request>,
    removed: HashSet<String>,
    sequence: u64,
}

impl Store {
    pub fn get(&self, request_id: &str) -> Option<&Request> {
        self.requests.get(request_id)
    }

    pub fn all(&self) -> Vec<&Request> {
        let mut requests: Vec<&Request> = self.requests.values().collect();
        requests.sort_by_key(|request| request.order);
        requests
    }

    // anything that arrives later for a removed request is dropped, otherwise it would reappear in the sidebar
    pub fn remove(&mut self, request_id: &str) {
        if self.requests.remove(request_id).is_some() {
            self.removed.insert(request_id.to_owned());
        }
    }

    pub fn clear(&mut self) {
        self.removed.extend(self.requests.drain().map(|(request_id, _)| request_id));
    }

    // merges a single incoming message into its request, returning the id of the request that changed
    fn ingest(&mut self, incoming: Value, now: u64) -> Option<String> {
        let Value::Object(mut incoming) = incoming else {
            eprintln!("[echobug] incoming message is not an object, skipping");
            return None;
        };

        let request_id = match incoming.get("requestId") {
            Some(Value::String(id)) if !id.is_empty() => id.clone(),
            Some(Value::Number(id)) => id.to_string(),
            _ => {
                eprintln!("[echobug] incoming message is missing requestId, skipping");
                return None;
            }
        };

        if self.removed.contains(&request_id) {
            return None;
        }

        self.sequence += 1;
        let sequence = self.sequence;

        let request = self.requests.entry(request_id.clone()).or_insert_with(|| Request {
            request_id: request_id.clone(),
            timestamp: now,
            order: sequence,
            ..Default::default()
        });

        if request.correlation_id.is_null() {
            if let Some(correlation_id) = incoming.get("correlationId") {
                request.correlation_id = correlation_id.clone();
            }
        }

        let kind = incoming.get("type").and_then(Value::as_str).unwrap_or("log");

        match kind {
            "request" => {
                let fields = [
                    ("method", &mut request.method),
                    ("url", &mut request.url),
                    ("status", &mut request.status),
                    ("duration", &mut request.duration),
                    ("memory", &mut request.memory),
                ];
                for (key, field) in fields {
                    match incoming.remove(key) {
                        Some(Value::Null) | None => {}
                        Some(value) => *field = value,
                    }
                }

                if let Some(started_at) = incoming.get("timestamp").and_then(Value::as_str).and_then(parse_utc_micros) {
                    request.started_at = Some(started_at);
                }

                if let Some(context) = incoming.remove("variables").or_else(|| incoming.remove("context")) {
                    deep_merge(&mut request.context, context);
                }
            }
            "query" => request.queries.push(stamp(incoming, now, sequence)),
            "timeline" => request.timeline.push(stamp(incoming, now, sequence)),
            _ => request.messages.push(stamp(incoming, now, sequence)),
        }

        Some(request_id)
    }
}

// the thread accepting clients, and the address it is listening on
struct Listener {
    address: SocketAddr,
    thread: JoinHandle<()>,
}

#[derive(Default)]
pub struct AppState {
    pub store: Mutex<Store>,
    pub settings: Mutex<Settings>,
    server_error: Mutex<Option<String>>,
    listener: Mutex<Option<Listener>>,
    generation: AtomicU64,
}

// timestamps are sent as utc strings and handed to the ui as epoch microseconds; a missing or invalid one falls back to
// when we received it, flagged so the ui knows it can't be compared with the sender's clock
fn stamp(mut entry: Map<String, Value>, now: u64, order: u64) -> Value {
    match entry.get("timestamp").and_then(Value::as_str).and_then(parse_utc_micros) {
        Some(timestamp) => {
            entry.insert("timestamp".into(), timestamp.into());
        }
        None => {
            entry.insert("timestamp".into(), now.into());
            entry.insert("timestampReceived".into(), true.into());
        }
    }
    entry.insert("order".into(), order.into());
    Value::Object(entry)
}

// parses "YYYY-MM-DDTHH:MM:SS[.fraction]Z" into epoch microseconds - utc only, anything else is rejected
fn parse_utc_micros(value: &str) -> Option<u64> {
    let value = value.strip_suffix('Z')?;
    let (date_time, fraction) = match value.split_once('.') {
        Some((date_time, fraction)) => (date_time, fraction),
        None => (value, ""),
    };

    let bytes = date_time.as_bytes();
    if bytes.len() != 19 || bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T' || bytes[13] != b':' || bytes[16] != b':' {
        return None;
    }
    let number = |range: std::ops::Range<usize>| -> Option<u64> {
        let digits = &date_time[range];
        digits.bytes().all(|byte| byte.is_ascii_digit()).then(|| digits.parse().ok()).flatten()
    };
    let (year, month, day) = (number(0..4)?, number(5..7)?, number(8..10)?);
    let (hour, minute, second) = (number(11..13)?, number(14..16)?, number(17..19)?);

    let is_leap_year = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let days_in_month = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year => 29,
        2 => 28,
        _ => return None,
    };
    if year < 1970 || day == 0 || day > days_in_month || hour > 23 || minute > 59 || second > 59 {
        return None;
    }

    if fraction.len() > 9 || (value.contains('.') && fraction.is_empty()) || !fraction.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let micros: u64 = format!("{:0<6}", &fraction[..fraction.len().min(6)]).parse().ok()?;

    // days since the unix epoch, from the "days from civil" algorithm
    let (y, m) = if month <= 2 { (year - 1, month + 9) } else { (year, month - 3) };
    let era = y / 400;
    let year_of_era = y - era * 400;
    let day_of_year = (153 * m + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;

    Some(((days * 86_400 + hour * 3_600 + minute * 60 + second) * 1_000_000) + micros)
}

fn deep_merge(target: &mut Value, source: Value) {
    match (target, source) {
        (_, Value::Null) => {}
        (Value::Object(target), Value::Object(source)) => {
            for (key, value) in source {
                deep_merge(target.entry(key).or_insert(Value::Null), value);
            }
        }
        (target, source) => *target = source,
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_micros() as u64)
        .unwrap_or_default()
}

pub fn status<R: Runtime>(app: &AppHandle<R>) -> Value {
    let state = app.state::<AppState>();
    let settings = state.settings.lock().unwrap();
    json!({ "port": settings.port, "host": settings.host, "error": *state.server_error.lock().unwrap() })
}

pub fn start<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<AppState>();
    *state.listener.lock().unwrap() = listen(app);
}

// stops listening and starts again with the current settings - requests we already have are kept
pub fn restart<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<AppState>();

    {
        let mut listener = state.listener.lock().unwrap();

        // the old thread only notices it has been replaced when a client connects, so connect to it
        // ourselves and wait for it to let go of the port in case we are about to listen on it again
        state.generation.fetch_add(1, Ordering::SeqCst);
        if let Some(Listener { mut address, thread }) = listener.take() {
            if address.ip().is_unspecified() {
                address.set_ip(Ipv4Addr::LOCALHOST.into());
            }
            if TcpStream::connect_timeout(&address, Duration::from_secs(1)).is_ok() {
                let _ = thread.join();
            }
        }

        *listener = listen(app);
    }

    if let Err(err) = app.emit("server-status-changed", status(app)) {
        eprintln!("[echobug] failed to notify the webview: {err}");
    }
}

fn listen<R: Runtime>(app: &AppHandle<R>) -> Option<Listener> {
    let state = app.state::<AppState>();
    let settings = state.settings.lock().unwrap().clone();
    let generation = state.generation.load(Ordering::SeqCst);

    let bound = TcpListener::bind((settings.host.as_str(), settings.port))
        .and_then(|listener| Ok((listener.local_addr()?, listener)));

    let (address, listener) = match bound {
        Ok(bound) => bound,
        Err(err) => {
            eprintln!("[echobug] failed to listen on {}:{}: {err}", settings.host, settings.port);
            *state.server_error.lock().unwrap() = Some(err.to_string());
            return None;
        }
    };

    *state.server_error.lock().unwrap() = None;

    println!("[echobug] listening on {address}");

    let app = app.clone();
    let thread = thread::spawn(move || {
        for stream in listener.incoming() {
            if app.state::<AppState>().generation.load(Ordering::SeqCst) != generation {
                break;
            }

            match stream {
                Ok(stream) => {
                    let app = app.clone();
                    thread::spawn(move || handle_client(stream, &app));
                }
                Err(err) => eprintln!("[echobug] failed to accept client: {err}"),
            }
        }
    });

    Some(Listener { address, thread })
}

fn handle_client<R: Runtime>(mut stream: TcpStream, app: &AppHandle<R>) {
    let mut buffer = Vec::new();
    let mut chunk = vec![0u8; 64 * 1024];

    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(read) => buffer.extend_from_slice(&chunk[..read]),
            Err(err) => {
                eprintln!("[echobug] socket error for client: {err}");
                break;
            }
        }

        // a payload can be split across several reads, or several payloads can arrive in one, so pull
        // out every complete json value and keep whatever is left over for the next read
        let mut payloads = Vec::new();
        let mut consumed = 0;
        let mut malformed = false;

        let mut values = Deserializer::from_slice(&buffer).into_iter::<Value>();
        loop {
            match values.next() {
                Some(Ok(payload)) => {
                    payloads.push(payload);
                    consumed = values.byte_offset();
                }
                Some(Err(err)) if err.is_eof() => break,
                Some(Err(err)) => {
                    eprintln!("[echobug] failed to parse incoming payload, closing connection: {err}");
                    malformed = true;
                    break;
                }
                None => {
                    consumed = buffer.len();
                    break;
                }
            }
        }

        buffer.drain(..consumed);

        for payload in payloads {
            handle_payload(payload, app);
        }

        if malformed {
            break;
        }

        if buffer.len() > MAX_BUFFER_SIZE {
            eprintln!("[echobug] incoming payload is too large, closing connection");
            break;
        }
    }
}

fn handle_payload<R: Runtime>(payload: Value, app: &AppHandle<R>) {
    let messages = match payload {
        Value::Array(messages) => messages,
        message => vec![message],
    };

    let now = now();

    let mut changed: Vec<String> = Vec::new();
    {
        let state = app.state::<AppState>();
        let mut store = state.store.lock().unwrap();
        for message in messages {
            if let Some(request_id) = store.ingest(message, now) {
                if !changed.contains(&request_id) {
                    changed.push(request_id);
                }
            }
        }
    }

    for request_id in changed {
        if let Err(err) = app.emit("request-received", json!({ "requestId": request_id })) {
            eprintln!("[echobug] failed to notify the webview: {err}");
        }
    }
}

#[cfg(test)]
mod tests;
