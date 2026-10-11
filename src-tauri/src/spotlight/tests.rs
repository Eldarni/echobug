use super::*;

const MESSAGE_ENVELOPE: &str = include_str!("../../tests/fixtures/sentry-message.envelope");
const EXCEPTION_ENVELOPE: &str = include_str!("../../tests/fixtures/sentry-exception.envelope");

const TRACE_ID: &str = "966850bddaeb4f15ba38d944e040613e";

fn messages_from(envelope: &str) -> Vec<Value> {
    parse_envelope(envelope.as_bytes()).unwrap().into_iter().flat_map(event_to_messages).collect()
}

#[test]
fn recognises_http_clients() {
    assert!(is_http(b"POST /stream HTTP/1.1\r\n"));
    assert!(is_http(b"OPTIONS /stream HTTP/1.1\r\n"));
    assert!(!is_http(b"[{\"type\":\"log\"}]"));
    assert!(!is_http(b"  {\"type\":\"log\"}"));
}

#[test]
fn waits_for_the_whole_http_head() {
    assert_eq!(parse_http_head(b"POST /stream HTTP/1.1\r\nContent-Length: 5\r\n"), Ok(None));

    let head = "POST /stream?x=1 HTTP/1.1\r\nHost: localhost\r\ncontent-length: 5\r\nExpect: 100-continue\r\n\r\n";
    assert_eq!(
        parse_http_head(format!("{head}hel").as_bytes()),
        Ok(Some(HttpHead { method: "POST".into(), path: "/stream".into(), body_start: head.len(), content_length: 5, expects_continue: true }))
    );
}

#[test]
fn rejects_http_bodies_it_cannot_read() {
    assert!(parse_http_head(b"POST /stream HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n").is_err());
    assert!(parse_http_head(b"POST /stream HTTP/1.1\r\nContent-Encoding: gzip\r\n\r\n").is_err());
    assert!(parse_http_head(b"POST /stream HTTP/1.1\r\nContent-Length: lots\r\n\r\n").is_err());
}

#[test]
fn reads_events_from_an_envelope_and_gives_them_the_envelope_event_id() {
    let events = parse_envelope(EXCEPTION_ENVELOPE.as_bytes()).unwrap();

    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["event_id"], "8cb5f4b416274443ab9cbb323036d866");
    assert_eq!(events[0]["exception"]["values"][1]["type"], "RuntimeException");
}

#[test]
fn skips_items_that_are_not_events_using_their_length() {
    let envelope = "{\"event_id\":\"abc\"}\n{\"type\":\"attachment\",\"length\":7}\nab\ncd\n\n{\"type\":\"event\"}\n{\"message\":\"hi\"}\n";

    let events = parse_envelope(envelope.as_bytes()).unwrap();
    assert_eq!(events, [json!({ "message": "hi", "event_id": "abc" })]);
}

#[test]
fn rejects_malformed_envelopes() {
    assert!(parse_envelope(b"not json\n").is_err());
    assert!(parse_envelope(b"{}\n{\"type\":\"event\"}\n{broken\n").is_err());
    assert!(parse_envelope(b"{}\n{\"type\":\"event\",\"length\":999}\n{}\n").is_err());
}

#[test]
fn a_message_event_becomes_a_message_grouped_by_trace() {
    let messages = messages_from(MESSAGE_ENVELOPE);
    assert_eq!(messages.len(), 2);

    let request = &messages[0];
    assert_eq!(request["type"], "request");
    assert_eq!(request["requestId"], format!("sentry:{TRACE_ID}"));
    assert_eq!(request["sentryTraceId"], TRACE_ID);
    assert_eq!(request["method"], "SENTRY");

    let message = &messages[1];
    // sentry treats an event without a level as an error
    assert_eq!(message["type"], "error");
    assert_eq!(message["requestId"], format!("sentry:{TRACE_ID}"));
    assert_eq!(message["value"], "Something happened");
    assert_eq!(message["timestamp"], "2026-10-11T10:35:28.485866Z");
    assert!(message.get("label").is_none());
    assert_eq!(message["sentry"]["breadcrumbs"]["values"][0]["message"], "Loaded the fixture");
}

#[test]
fn an_exception_event_is_located_at_the_newest_frame_outside_vendor() {
    let messages = messages_from(EXCEPTION_ENVELOPE);
    let message = &messages[1];

    assert_eq!(message["type"], "error");
    assert_eq!(message["label"], "RuntimeException");
    assert_eq!(message["value"], "Something broke");
    assert_eq!(message["file"], "routes/web.php");
    assert_eq!(message["line"], 8);
    assert_eq!(messages[0]["url"], "RuntimeException");
}

#[test]
fn maps_sentry_levels_to_message_types() {
    for (level, expected) in [("debug", "log"), ("info", "info"), ("warning", "warn"), ("error", "error"), ("fatal", "error")] {
        let messages = event_to_messages(json!({ "event_id": "a", "level": level, "message": "hi" }));
        assert_eq!(messages[1]["type"], expected, "{level}");
    }
}

#[test]
fn takes_the_message_from_any_of_its_shapes() {
    for message in [json!("hi"), json!({ "formatted": "hi" }), json!({ "message": "hi" })] {
        let messages = event_to_messages(json!({ "event_id": "a", "message": message }));
        assert_eq!(messages[1]["value"], "hi");
    }
}

#[test]
fn the_sidebar_shows_the_request_sentry_saw() {
    let messages = event_to_messages(json!({
        "event_id": "a",
        "message": "hi",
        "request": { "method": "POST", "url": "http://localhost/api/posts" },
    }));

    assert_eq!(messages[0]["requestId"], "sentry:a");
    assert_eq!(messages[0]["method"], "POST");
    assert_eq!(messages[0]["url"], "http://localhost/api/posts");
}

#[test]
fn events_without_an_id_are_skipped() {
    assert!(event_to_messages(json!({ "message": "hi" })).is_empty());
}
