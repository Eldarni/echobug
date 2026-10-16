// sentry sdks with spotlight enabled post every envelope to "<spotlight_url>/stream" - pointing that url at echobug is all
// a sender has to do, so everything here works from what a stock sentry sdk sends
use serde_json::{json, Map, Value};

// a client talking http rather than streaming json starts with a method - json starts with "[", "{" or whitespace
const HTTP_METHODS: [&str; 4] = ["POST ", "OPTIONS ", "PUT ", "GET "];

pub fn is_http(buffer: &[u8]) -> bool {
    HTTP_METHODS.iter().any(|method| buffer.starts_with(method.as_bytes()))
}

#[derive(Debug, PartialEq)]
pub struct HttpHead {
    pub method: String,
    pub path: String,
    pub body_start: usize,
    pub content_length: usize,
    pub expects_continue: bool,
}

// None until the headers are complete - only what sentry's spotlight client sends is supported, so a body has to come
// with a content length, and can't be compressed
pub fn parse_http_head(buffer: &[u8]) -> Result<Option<HttpHead>, String> {
    let Some(end) = buffer.windows(4).position(|window| window == b"\r\n\r\n") else {
        return Ok(None);
    };

    let head = std::str::from_utf8(&buffer[..end]).map_err(|_| "the request headers are not utf-8")?;
    let mut lines = head.split("\r\n");

    let mut request_line = lines.next().unwrap_or_default().split(' ');
    let (Some(method), Some(target)) = (request_line.next(), request_line.next()) else {
        return Err("the request line is malformed".into());
    };

    let mut parsed = HttpHead {
        method: method.to_owned(),
        path: target.split('?').next().unwrap_or_default().to_owned(),
        body_start: end + 4,
        content_length: 0,
        expects_continue: false,
    };

    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            return Err(format!("malformed header \"{line}\""));
        };
        let value = value.trim();

        match name.trim().to_ascii_lowercase().as_str() {
            "content-length" => parsed.content_length = value.parse().map_err(|_| format!("invalid content length \"{value}\""))?,
            "expect" => parsed.expects_continue = value.eq_ignore_ascii_case("100-continue"),
            "transfer-encoding" if !value.eq_ignore_ascii_case("identity") => return Err("chunked requests are not supported".into()),
            "content-encoding" if !value.eq_ignore_ascii_case("identity") => return Err(format!("{value} encoded requests are not supported")),
            _ => {}
        }
    }

    Ok(Some(parsed))
}

// an envelope is a header line followed by items, each an item header line and a payload - the payload is "length"
// bytes long when the item header says so, otherwise it runs to the end of the line
//
// only events are kept (messages and exceptions), and each is given the event id from the envelope header as sentry
// leaves it out of the event itself
pub fn parse_envelope(body: &[u8]) -> Result<Vec<Value>, String> {
    let (header, mut rest) = split_line(body);
    let header: Value = serde_json::from_slice(header).map_err(|err| format!("invalid envelope header: {err}"))?;

    let mut events = Vec::new();

    while !rest.iter().all(u8::is_ascii_whitespace) {
        let (item_header, after_header) = split_line(rest);
        let item_header: Value = serde_json::from_slice(item_header).map_err(|err| format!("invalid item header: {err}"))?;

        let (payload, after_payload) = match item_header.get("length").and_then(Value::as_u64) {
            Some(length) => {
                let length = usize::try_from(length).ok().filter(|length| *length <= after_header.len()).ok_or("an item is longer than the envelope")?;
                let (payload, after) = after_header.split_at(length);
                (payload, after.strip_prefix(b"\n").unwrap_or(after))
            }
            None => split_line(after_header),
        };
        rest = after_payload;

        if item_header.get("type").and_then(Value::as_str) != Some("event") {
            continue;
        }

        let mut event: Value = serde_json::from_slice(payload).map_err(|err| format!("invalid event: {err}"))?;
        if let (Some(event), Some(event_id)) = (event.as_object_mut(), header.get("event_id")) {
            event.entry("event_id").or_insert_with(|| event_id.clone());
        }
        events.push(event);
    }

    Ok(events)
}

fn split_line(bytes: &[u8]) -> (&[u8], &[u8]) {
    match bytes.iter().position(|byte| *byte == b'\n') {
        Some(end) => (&bytes[..end], &bytes[end + 1..]),
        None => (bytes, &[]),
    }
}

// turns a sentry event into an echobug exception - the summary the sidebar shows, and the whole event kept as the raw
// payload for the detail view
pub fn event_to_exception(event: Value) -> Value {
    let exception = event.pointer("/exception/values").and_then(Value::as_array).and_then(|values| values.last());
    let frames = exception.and_then(|exception| exception.pointer("/stacktrace/frames")).and_then(Value::as_array);

    let label = exception.and_then(|exception| exception.get("type")).cloned();
    let value = exception
        .and_then(|exception| exception.get("value"))
        .or_else(|| event.pointer("/message/formatted"))
        .or_else(|| event.pointer("/message/message"))
        .or_else(|| event.get("message").filter(|message| message.is_string()))
        .cloned()
        .unwrap_or_else(|| json!(""));

    let (file, line) = frames.map(|frames| location(frames)).unwrap_or_default();

    // the function that threw - the newest frame, wherever it is
    let function = frames.and_then(|frames| frames.last()).and_then(|frame| frame.get("function")).cloned();

    let timestamp = event.get("timestamp").and_then(Value::as_f64).filter(|seconds| *seconds >= 0.0).map(|seconds| (seconds * 1_000_000.0).round() as u64);

    // what the sentry sdk saw of the request, for when the echobug request never turns up
    let url = event.pointer("/request/url").or_else(|| event.get("transaction")).cloned();
    let method = event.pointer("/request/method").cloned();

    without_nulls(json!({
        "source": "sentry",
        "level": level(&event),
        "label": label,
        "value": value,
        "file": file,
        "line": line,
        "function": function,
        "timestamp": timestamp,
        "method": method,
        "url": url,
        "raw": event,
    }))
}

// sentry treats an event without a level as an error - levels are the same as echobug's own message types
fn level(event: &Value) -> &'static str {
    match event.get("level").and_then(Value::as_str).unwrap_or("error") {
        "debug" => "log",
        "info" => "info",
        "warning" => "warn",
        _ => "error",
    }
}

// where the exception was thrown - the newest frame outside vendor, as stock sentry marks every frame as in app
fn location(frames: &[Value]) -> (Option<Value>, Option<Value>) {
    let path = |frame: &Value| frame.get("abs_path").or_else(|| frame.get("filename")).and_then(Value::as_str).map(str::to_owned);

    let frame = frames.iter().rev().find(|frame| frame["in_app"] != false && path(frame).is_some_and(|path| !is_vendor(&path))).or_else(|| frames.last());

    let Some(frame) = frame else {
        return (None, None);
    };

    let file = path(frame).map(|file| relative_to_project(&file, frames));

    (file.map(Value::from), frame.get("lineno").cloned())
}

fn is_vendor(path: &str) -> bool {
    path.contains("/vendor/") || path.contains("\\vendor\\")
}

// the project root is wherever vendor lives - echobug's own messages use project relative paths, so these should too
fn relative_to_project(file: &str, frames: &[Value]) -> String {
    let root = frames
        .iter()
        .filter_map(|frame| frame.get("abs_path").and_then(Value::as_str))
        .find_map(|path| path.find("/vendor/").map(|index| &path[..=index]));

    match root {
        Some(root) => file.strip_prefix(root).unwrap_or(file).to_owned(),
        None => file.to_owned(),
    }
}

fn without_nulls(value: Value) -> Value {
    match value {
        Value::Object(fields) => Value::Object(fields.into_iter().filter(|(_, field)| !field.is_null()).collect::<Map<String, Value>>()),
        value => value,
    }
}

#[cfg(test)]
mod tests;
