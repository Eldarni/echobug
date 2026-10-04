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

    timestamp: u64,
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
            "timestamp": self.timestamp,
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

// the sender is not required to say when something happened, so fall back to when we received it
fn stamp(mut entry: Map<String, Value>, now: u64, order: u64) -> Value {
    entry.entry("timestamp").or_insert_with(|| now.into());
    entry.insert("order".into(), order.into());
    Value::Object(entry)
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
        .map(|elapsed| elapsed.as_millis() as u64)
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
