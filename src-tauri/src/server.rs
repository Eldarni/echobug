use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::protocol::{self, Message};
use crate::settings::Settings;
use crate::spotlight;

// a client that never finishes a line should not be able to grow its buffer forever
const MAX_BUFFER_SIZE: usize = 64 * 1024 * 1024;

// the window that shows payloads exactly as clients sent them
pub const PAYLOADS_WINDOW: &str = "payloads";

// how much of a malformed payload is shown in the payloads window, it could be most of the buffer
const MAX_MALFORMED_PREVIEW: usize = 64 * 1024;

#[derive(Default)]
pub struct Request {
    request_id: String,
    correlation_id: Option<String>,

    // when the sender says the request started, and the earliest timestamp of any of its messages - the start time
    // wins whenever one has been sent (both epoch microseconds)
    start_time: Option<u64>,
    earliest: Option<u64>,
    order: u64,

    method: Option<String>,
    url: Option<String>,
    status: Option<u16>,

    duration: Option<u64>,
    memory: Option<u64>,

    // where the sender's xdebug profile was written, as the sender sees it
    cachegrind: Option<String>,

    // sections of the context tab, each { label, order, values }
    context: Map<String, Value>,

    messages: Vec<Value>,
    queries: Vec<Value>,
}

impl Request {
    pub fn summary(&self) -> Value {
        json!({
            "requestId": self.request_id,
            "correlationId": self.correlation_id,
            "startedAt": self.start(),
            "order": self.order,
            "method": self.method,
            "url": self.url,
            "status": self.status,
            "duration": self.duration,
            "memory": self.memory,
            "cachegrind": self.cachegrind,
            "messagesCount": self.messages.len(),
            "queriesCount": self.queries.len(),
        })
    }

    pub fn start(&self) -> Option<u64> {
        self.start_time.or(self.earliest)
    }

    pub fn cachegrind(&self) -> Option<&str> {
        self.cachegrind.as_deref()
    }

    pub fn context(&self) -> &Map<String, Value> {
        &self.context
    }

    pub fn messages(&self) -> &[Value] {
        &self.messages
    }

    pub fn queries(&self) -> &[Value] {
        &self.queries
    }
}

// something that went wrong, from whichever system reported it - the summary is all the sidebar needs, and the payload
// the system sent is kept for the detail view, which renders it based on its source
pub struct Exception {
    id: u64,
    timestamp: u64,
    summary: Map<String, Value>,
    raw: Value,
}

#[derive(Default)]
pub struct Store {
    requests: HashMap<String, Request>,
    removed: HashSet<String>,
    sequence: u64,

    // exceptions are kept apart from requests, and cleared separately - in the order they arrived
    exceptions: Vec<Exception>,
    exception_sequence: u64,
}

impl Exception {
    fn summary(&self) -> Value {
        let mut summary = self.summary.clone();
        summary.insert("id".into(), self.id.into());
        summary.insert("timestamp".into(), self.timestamp.into());
        Value::Object(summary)
    }
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

    pub fn exceptions(&self) -> Vec<Value> {
        self.exceptions.iter().map(Exception::summary).collect()
    }

    // the summary along with the payload the source sent
    pub fn exception(&self, id: u64) -> Option<Value> {
        let exception = self.exceptions.iter().find(|exception| exception.id == id)?;
        let mut summary = exception.summary();
        summary["raw"] = exception.raw.clone();
        Some(summary)
    }

    pub fn clear_exceptions(&mut self) {
        self.exceptions.clear();
    }

    pub fn remove_exception(&mut self, id: u64) {
        self.exceptions.retain(|exception| exception.id != id);
    }

    // stores an exception, returning its id
    fn add_exception(&mut self, incoming: Value, now: u64) -> Option<u64> {
        let Value::Object(mut summary) = incoming else {
            eprintln!("[echobug] incoming exception is not an object, skipping");
            return None;
        };

        let raw = summary.remove("raw").unwrap_or_default();

        // the source's clock where it has one, otherwise when it arrived - flagged, as with messages
        let timestamp = match summary.remove("timestamp").and_then(|timestamp| timestamp.as_u64()) {
            Some(timestamp) => timestamp,
            None => {
                summary.insert("timestampReceived".into(), true.into());
                now
            }
        };

        self.exception_sequence += 1;
        self.exceptions.push(Exception { id: self.exception_sequence, timestamp, summary, raw });

        Some(self.exception_sequence)
    }

    // merges a single message into its request, returning the id of the request that changed - messages can arrive
    // before their request, which is filled in when it turns up
    fn ingest(&mut self, message: Message) -> Option<String> {
        let request_id = message.request_id().to_owned();

        if self.removed.contains(&request_id) {
            return None;
        }

        self.sequence += 1;
        let sequence = self.sequence;

        let request = self.requests.entry(request_id.clone()).or_insert_with(|| Request {
            request_id: request_id.clone(),
            order: sequence,
            ..Default::default()
        });

        request.earliest = Some(request.earliest.map_or(message.timestamp(), |earliest| earliest.min(message.timestamp())));

        match message {
            // every field that is sent replaces what was there, and the context is merged section by section
            Message::Request(message) => {
                replace(&mut request.start_time, message.start_time);

                replace(&mut request.correlation_id, message.correlation_id);
                replace(&mut request.method, message.method);
                replace(&mut request.url, message.url);
                replace(&mut request.status, message.status);
                replace(&mut request.duration, message.duration);
                replace(&mut request.memory, message.memory);
                replace(&mut request.cachegrind, message.cachegrind);

                for (key, section) in message.context.unwrap_or_default() {
                    let existing = request.context.entry(key).or_insert_with(|| json!({ "values": {} }));
                    if let Some(label) = section.label {
                        existing["label"] = label.into();
                    }
                    if let Some(order) = section.order {
                        existing["order"] = order.into();
                    }
                    if let Some(values) = existing["values"].as_object_mut() {
                        values.extend(section.values);
                    }
                }
            }
            Message::Log(message) => request.messages.push(entry("log", &message, sequence)),
            Message::Info(message) => request.messages.push(entry("info", &message, sequence)),
            Message::Warn(message) => request.messages.push(entry("warn", &message, sequence)),
            Message::Error(message) => request.messages.push(entry("error", &message, sequence)),
            Message::Query(message) => request.queries.push(entry("query", &message, sequence)),
        }

        Some(request_id)
    }
}

// the thread accepting clients, and the address it is listening on
struct Listener {
    address: SocketAddr,
    thread: JoinHandle<()>,
}

// rejections that arrive before the payloads window is listening wait here, so opening the window for one doesn't
// lose it - only the most recent are kept, the same as the window itself
const MAX_PENDING_PAYLOADS: usize = 500;

#[derive(Default)]
pub struct PayloadsWindow {
    listening: bool,
    pending: Vec<Value>,
}

impl PayloadsWindow {
    // true when the window is listening and the payload can be sent straight to it
    pub fn queue(&mut self, payload: Value) -> bool {
        if self.listening {
            return true;
        }

        self.pending.push(payload);
        if self.pending.len() > MAX_PENDING_PAYLOADS {
            self.pending.drain(..self.pending.len() - MAX_PENDING_PAYLOADS);
        }
        false
    }

    // the window is listening from here on, so it gets everything that was waiting for it
    pub fn take(&mut self) -> Vec<Value> {
        self.listening = true;
        std::mem::take(&mut self.pending)
    }

    pub fn closed(&mut self) {
        self.listening = false;
        self.pending.clear();
    }
}

#[derive(Default)]
pub struct AppState {
    pub store: Mutex<Store>,
    pub settings: Mutex<Settings>,
    pub payloads: Mutex<PayloadsWindow>,
    server_error: Mutex<Option<String>>,
    listener: Mutex<Option<Listener>>,
    generation: AtomicU64,
}

// a field that wasn't sent leaves what was there alone
fn replace<T>(field: &mut Option<T>, value: Option<T>) {
    if value.is_some() {
        *field = value;
    }
}

// what the ui gets for a message or a query - the message as it was sent, with its timestamp in epoch microseconds,
// its type, and the order it arrived in
fn entry(kind: &str, message: &impl serde::Serialize, order: u64) -> Value {
    let mut entry = serde_json::to_value(message).unwrap_or_default();
    entry["type"] = kind.into();
    entry["order"] = order.into();
    entry
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
    let client = stream.peer_addr().map(|address| address.to_string()).unwrap_or_default();
    let mut buffer = Vec::new();
    let mut chunk = vec![0u8; 64 * 1024];

    let mut is_first_read = true;

    loop {
        match stream.read(&mut chunk) {
            // every line has to end with a newline, so anything left when the client goes was never finished
            Ok(0) => {
                if !buffer.iter().all(u8::is_ascii_whitespace) {
                    eprintln!("[echobug] client closed the connection part way through a line, dropping it");
                    report_rejection(app, &client, &buffer[..buffer.len().min(MAX_MALFORMED_PREVIEW)], "the line was never finished with a newline".into());
                }
                break;
            }
            Ok(read) => buffer.extend_from_slice(&chunk[..read]),
            Err(err) => {
                eprintln!("[echobug] socket error for client: {err}");
                break;
            }
        }

        // sentry sdks talk http (spotlight), our own clients just stream json
        if std::mem::take(&mut is_first_read) && spotlight::is_http(&buffer) {
            return handle_http(stream, buffer, &client, app);
        }

        // newline delimited json - every complete line is a message or an array of messages, and anything after the
        // last newline waits for the rest of its line
        let mut payloads = Vec::new();
        let mut consumed = 0;
        let mut malformed = false;

        // the raw text of accepted payloads is only kept while somebody is watching the payloads window
        let watching = app.get_webview_window(PAYLOADS_WINDOW).is_some();

        while let Some(length) = buffer[consumed..].iter().position(|byte| *byte == b'\n') {
            let line = &buffer[consumed..consumed + length];
            consumed += length + 1;

            if line.iter().all(u8::is_ascii_whitespace) {
                continue;
            }

            match serde_json::from_slice::<Value>(line) {
                Ok(payload) => {
                    if watching {
                        emit_raw_payload(app, &client, line);
                    }
                    payloads.push(payload);
                }
                Err(err) => {
                    eprintln!("[echobug] failed to parse incoming line, closing connection: {err}");
                    report_rejection(app, &client, &line[..line.len().min(MAX_MALFORMED_PREVIEW)], format!("not a json value: {err}"));
                    malformed = true;
                    break;
                }
            }
        }

        buffer.drain(..consumed);

        for payload in payloads {
            handle_payload(payload, &client, app);
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

// one request per connection - the response goes out before the envelope is processed, the sender is waiting on it
fn handle_http<R: Runtime>(mut stream: TcpStream, mut buffer: Vec<u8>, client: &str, app: &AppHandle<R>) {
    let mut chunk = vec![0u8; 64 * 1024];
    let mut has_continued = false;

    loop {
        match spotlight::parse_http_head(&buffer) {
            Err(err) => {
                eprintln!("[echobug] failed to parse incoming http request: {err}");
                respond(&mut stream, "400 Bad Request");
                return;
            }
            Ok(Some(head)) => {
                let body_end = head.body_start + head.content_length;

                if buffer.len() >= body_end {
                    if head.method == "OPTIONS" {
                        respond(&mut stream, "204 No Content");
                    } else if head.method != "POST" || head.path != "/stream" {
                        respond(&mut stream, "404 Not Found");
                    } else {
                        respond(&mut stream, "200 OK");
                        handle_envelope(&buffer[head.body_start..body_end], client, app);
                    }
                    return;
                }

                if head.expects_continue && !has_continued {
                    has_continued = true;
                    let _ = stream.write_all(b"HTTP/1.1 100 Continue\r\n\r\n");
                }
            }
            Ok(None) => {}
        }

        if buffer.len() > MAX_BUFFER_SIZE {
            eprintln!("[echobug] incoming payload is too large, closing connection");
            respond(&mut stream, "413 Content Too Large");
            return;
        }

        match stream.read(&mut chunk) {
            Ok(0) => return,
            Ok(read) => buffer.extend_from_slice(&chunk[..read]),
            Err(err) => {
                eprintln!("[echobug] socket error for client: {err}");
                return;
            }
        }
    }
}

// spotlight is also used from the browser, so preflight requests are allowed
fn respond(stream: &mut TcpStream, status: &str) {
    let response = format!(
        "HTTP/1.1 {status}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: POST, OPTIONS\r\nAccess-Control-Allow-Headers: *\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

fn handle_envelope<R: Runtime>(body: &[u8], client: &str, app: &AppHandle<R>) {
    match spotlight::parse_envelope(body) {
        Ok(events) => {
            if app.get_webview_window(PAYLOADS_WINDOW).is_some() {
                emit_raw_payload(app, client, body);
            }
            handle_exceptions(events.into_iter().map(spotlight::event_to_exception).collect(), app);
        }
        Err(err) => {
            eprintln!("[echobug] failed to parse incoming sentry envelope: {err}");
            report_rejection(app, client, &body[..body.len().min(MAX_MALFORMED_PREVIEW)], err);
        }
    }
}

fn raw_payload(client: &str, raw: &[u8], error: Option<String>) -> Value {
    json!({
        "client": client,
        "received": now(),
        "raw": String::from_utf8_lossy(raw).trim(),
        "error": error,
    })
}

fn emit_raw_payload<R: Runtime>(app: &AppHandle<R>, client: &str, raw: &[u8]) {
    emit_to_payloads_window(app, raw_payload(client, raw, None));
}

fn emit_to_payloads_window<R: Runtime>(app: &AppHandle<R>, payload: Value) {
    if let Err(err) = app.emit_to(PAYLOADS_WINDOW, "payload-received", payload) {
        eprintln!("[echobug] failed to notify the payloads window: {err}");
    }
}

// client authors need to see what was rejected, so a rejection opens the payloads window if it isn't already open -
// it waits until the window is listening, so it isn't lost while the window loads. Building a window waits on the
// main thread, so this mustn't be called while holding a lock a command could be waiting on
fn report_rejection<R: Runtime>(app: &AppHandle<R>, client: &str, raw: &[u8], error: String) {
    let payload = raw_payload(client, raw, Some(error));

    {
        let state = app.state::<AppState>();
        let mut payloads = state.payloads.lock().unwrap();
        if payloads.queue(payload.clone()) {
            return emit_to_payloads_window(app, payload);
        }
    }

    if app.get_webview_window(PAYLOADS_WINDOW).is_none() {
        if let Err(err) = crate::open_payloads_window(app) {
            eprintln!("[echobug] failed to open the payloads window: {err}");
        }
    }
}

// each message is checked on its own, so one that breaks the protocol doesn't take the rest of its batch with it
fn handle_payload<R: Runtime>(payload: Value, client: &str, app: &AppHandle<R>) {
    let messages = match payload {
        Value::Array(messages) => messages,
        message => vec![message],
    };

    let mut changed: Vec<String> = Vec::new();
    let mut rejected: Vec<(Value, String)> = Vec::new();
    {
        let state = app.state::<AppState>();
        let mut store = state.store.lock().unwrap();
        for message in messages {
            let message = match protocol::parse(message.clone()) {
                Ok(parsed) => parsed,
                Err(err) => {
                    eprintln!("[echobug] rejected a message: {err}");
                    rejected.push((message, format!("rejected: {err}")));
                    continue;
                }
            };

            if let Some(request_id) = store.ingest(message) {
                if !changed.contains(&request_id) {
                    changed.push(request_id);
                }
            }
        }
    }

    // reported once the store is unlocked, reporting one can open the payloads window
    for (message, err) in rejected {
        report_rejection(app, client, message.to_string().as_bytes(), err);
    }

    for request_id in changed {
        emit(app, "request-received", json!({ "requestId": request_id }));
    }
}

fn handle_exceptions<R: Runtime>(exceptions: Vec<Value>, app: &AppHandle<R>) {
    let now = now();

    let added: Vec<u64> = {
        let state = app.state::<AppState>();
        let mut store = state.store.lock().unwrap();
        exceptions.into_iter().filter_map(|exception| store.add_exception(exception, now)).collect()
    };

    for id in added {
        emit(app, "exception-received", json!({ "id": id }));
    }
}

fn emit<R: Runtime>(app: &AppHandle<R>, event: &str, payload: Value) {
    if let Err(err) = app.emit(event, payload) {
        eprintln!("[echobug] failed to notify the webview: {err}");
    }
}

#[cfg(test)]
mod tests;
