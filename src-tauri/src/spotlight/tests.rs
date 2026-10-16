use super::*;

const MESSAGE_ENVELOPE: &str = include_str!("../../tests/fixtures/sentry-message.envelope");
const EXCEPTION_ENVELOPE: &str = include_str!("../../tests/fixtures/sentry-exception.envelope");

fn exception_from(envelope: &str) -> Value {
    event_to_exception(parse_envelope(envelope.as_bytes()).unwrap().remove(0))
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
fn a_message_event_becomes_an_exception() {
    let exception = exception_from(MESSAGE_ENVELOPE);

    assert_eq!(exception["source"], "sentry");
    // sentry treats an event without a level as an error
    assert_eq!(exception["level"], "error");
    assert_eq!(exception["value"], "Something happened");
    assert_eq!(exception["timestamp"], 1_791_714_928_485_866u64);
    assert!(exception.get("label").is_none());
    assert!(exception.get("url").is_none());
    assert_eq!(exception["raw"]["breadcrumbs"]["values"][0]["message"], "Loaded the fixture");
}

#[test]
fn an_exception_event_is_located_at_the_newest_frame_outside_vendor() {
    let exception = exception_from(EXCEPTION_ENVELOPE);

    assert_eq!(exception["level"], "error");
    assert_eq!(exception["label"], "RuntimeException");
    assert_eq!(exception["value"], "Something broke");
    assert_eq!(exception["file"], "routes/web.php");
    assert_eq!(exception["line"], 8);
}

#[test]
fn maps_sentry_levels_to_echobug_levels() {
    for (level, expected) in [("debug", "log"), ("info", "info"), ("warning", "warn"), ("error", "error"), ("fatal", "error")] {
        let exception = event_to_exception(json!({ "level": level, "message": "hi" }));
        assert_eq!(exception["level"], expected, "{level}");
    }
}

#[test]
fn takes_the_message_from_any_of_its_shapes() {
    for message in [json!("hi"), json!({ "formatted": "hi" }), json!({ "message": "hi" })] {
        let exception = event_to_exception(json!({ "message": message }));
        assert_eq!(exception["value"], "hi");
    }
}

#[test]
fn keeps_the_request_sentry_saw() {
    let exception = event_to_exception(json!({
        "message": "hi",
        "request": { "method": "POST", "url": "http://localhost/api/posts" },
    }));

    assert_eq!(exception["method"], "POST");
    assert_eq!(exception["url"], "http://localhost/api/posts");
}

#[test]
fn falls_back_to_the_transaction_for_the_url() {
    let exception = event_to_exception(json!({ "message": "hi", "transaction": "/api/posts" }));
    assert_eq!(exception["url"], "/api/posts");
}
