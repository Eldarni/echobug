use super::*;

fn ingest_all(store: &mut Store, payload: &str) -> Vec<Option<String>> {
    let Value::Array(messages) = serde_json::from_str(payload).unwrap() else {
        panic!("example payload should be an array");
    };
    messages.into_iter().map(|message| store.ingest(message, 1000)).collect()
}

fn unused_port() -> u16 {
    TcpListener::bind(("127.0.0.1", 0)).unwrap().local_addr().unwrap().port()
}

fn can_connect(port: u16) -> bool {
    TcpStream::connect(("127.0.0.1", port)).is_ok()
}

#[test]
fn restart_follows_the_settings() {
    let app = tauri::test::mock_app();
    app.manage(AppState::default());

    let app = app.handle();
    let listen_on = |port: u16| {
        app.state::<AppState>().settings.lock().unwrap().port = port;
        restart(app);
        status(app)["error"].clone()
    };

    let first = unused_port();
    assert_eq!(listen_on(first), Value::Null);
    assert!(can_connect(first));

    // the old listener has to let go of the port before we can listen on it again
    assert_eq!(listen_on(first), Value::Null);
    assert!(can_connect(first));

    let second = unused_port();
    assert_eq!(listen_on(second), Value::Null);
    assert!(can_connect(second));
    assert!(!can_connect(first));

    // a port that somebody else has is reported, and we can recover from it
    let taken = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    assert!(listen_on(taken.local_addr().unwrap().port()).is_string());
    assert!(!can_connect(second));

    assert_eq!(listen_on(first), Value::Null);
    assert!(can_connect(first));
}

#[test]
fn groups_messages_by_request() {
    let mut store = Store::default();
    ingest_all(&mut store, include_str!("../../tests/fixtures/messages.json"));

    let requests = store.all();
    assert_eq!(requests.len(), 1);

    let summary = requests[0].summary();
    assert_eq!(summary["method"], "GET");
    assert_eq!(summary["status"], 200);
    assert_eq!(summary["messagesCount"], 8);
    assert_eq!(summary["queriesCount"], 0);

    // messages without a timestamp get the time we received them, flagged as such
    assert_eq!(requests[0].messages()[0]["timestamp"], 1000);
    assert_eq!(requests[0].messages()[0]["timestampReceived"], true);
}

#[test]
fn separates_queries_from_messages() {
    let mut store = Store::default();
    ingest_all(&mut store, include_str!("../../tests/fixtures/queries.json"));

    let request = store.all()[0];
    assert_eq!(request.queries().len(), 8);
    assert!(request.messages().is_empty());

    // a utc timestamp sent by the client becomes epoch microseconds
    assert_eq!(request.queries()[0]["timestamp"], 1_759_005_930_000_000_u64);
    assert!(request.queries()[0].get("timestampReceived").is_none());
}

#[test]
fn keeps_requests_in_arrival_order() {
    let mut store = Store::default();
    ingest_all(&mut store, include_str!("../../tests/fixtures/request-methods.json"));

    let methods: Vec<Value> = store.all().iter().map(|request| request.summary()["method"].clone()).collect();
    assert_eq!(methods, ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS", "CONNECT"]);
}

#[test]
fn stores_variables_as_context() {
    let mut store = Store::default();
    ingest_all(&mut store, include_str!("../../tests/fixtures/request-variables.json"));

    let context = store.all()[0].context();
    assert_eq!(context["cookies"]["values"]["session"], "123");
}

#[test]
fn later_request_messages_update_rather_than_replace() {
    let mut store = Store::default();
    ingest_all(
        &mut store,
        r#"[
            { "type": "log", "requestId": "a", "correlationId": "b", "value": "before the request" },
            { "type": "request", "requestId": "a", "correlationId": "b", "method": "GET", "url": "/", "variables": { "one": { "values": { "x": "1" } } } },
            { "type": "request", "requestId": "a", "correlationId": "b", "status": 200, "variables": { "one": { "values": { "y": "2" } } } }
        ]"#,
    );

    let request = store.get("a").unwrap();
    let summary = request.summary();
    assert_eq!(summary["method"], "GET");
    assert_eq!(summary["status"], 200);
    assert_eq!(summary["messagesCount"], 1);
    assert_eq!(request.context()["one"]["values"], json!({ "x": "1", "y": "2" }));
}

#[test]
fn skips_messages_without_a_request_id() {
    let mut store = Store::default();
    let changed = ingest_all(&mut store, r#"[{ "type": "log", "value": "orphan" }, "not an object"]"#);

    assert_eq!(changed, [None, None]);
    assert!(store.all().is_empty());
}

#[test]
fn removed_requests_stay_removed() {
    let mut store = Store::default();
    ingest_all(&mut store, r#"[{ "type": "request", "requestId": "a", "correlationId": "b" }]"#);
    store.remove("a");

    let changed = ingest_all(&mut store, r#"[{ "type": "log", "requestId": "a", "correlationId": "b", "value": "late" }]"#);
    assert_eq!(changed, [None]);
    assert!(store.get("a").is_none());
}

#[test]
fn clearing_removes_every_request() {
    let mut store = Store::default();
    ingest_all(&mut store, include_str!("../../tests/fixtures/request-methods.json"));
    store.clear();
    assert!(store.all().is_empty());

    // the cleared requests stay gone, but new ones are still accepted
    ingest_all(&mut store, include_str!("../../tests/fixtures/request-methods.json"));
    assert!(store.all().is_empty());

    ingest_all(&mut store, include_str!("../../tests/fixtures/messages.json"));
    assert_eq!(store.all().len(), 1);
}

#[test]
fn parses_utc_timestamps_to_microseconds() {
    assert_eq!(parse_utc_micros("1970-01-01T00:00:00Z"), Some(0));
    assert_eq!(parse_utc_micros("2025-09-27T20:45:30Z"), Some(1_759_005_930_000_000));
    assert_eq!(parse_utc_micros("2025-09-27T20:45:30.5Z"), Some(1_759_005_930_500_000));
    assert_eq!(parse_utc_micros("2025-09-27T20:45:30.123Z"), Some(1_759_005_930_123_000));
    assert_eq!(parse_utc_micros("2025-09-27T20:45:30.123456Z"), Some(1_759_005_930_123_456));
    assert_eq!(parse_utc_micros("2025-09-27T20:45:30.123456789Z"), Some(1_759_005_930_123_456));
    assert_eq!(parse_utc_micros("2024-02-29T12:00:00Z"), Some(1_709_208_000_000_000));
}

#[test]
fn rejects_timestamps_that_are_not_utc() {
    for value in [
        "2025-09-27T20:45:30+03:00",
        "2025-09-27T20:45:30",
        "2025-09-27 20:45:30Z",
        "2025-09-27T20:45:30.Z",
        "2025-09-27T20:45:30.1234567890Z",
        "2026-13-01T00:00:00Z",
        "2025-02-29T00:00:00Z",
        "2025-09-27T24:00:00Z",
        "1759005930000",
        "",
    ] {
        assert_eq!(parse_utc_micros(value), None, "{value}");
    }
}

#[test]
fn invalid_timestamps_fall_back_to_the_receive_time() {
    let mut store = Store::default();
    ingest_all(
        &mut store,
        r#"[
            { "type": "log", "requestId": "a", "value": "offset", "timestamp": "2025-09-27T20:45:30+03:00" },
            { "type": "log", "requestId": "a", "value": "epoch", "timestamp": 1759005930000 }
        ]"#,
    );

    for message in store.get("a").unwrap().messages() {
        assert_eq!(message["timestamp"], 1000);
        assert_eq!(message["timestampReceived"], true);
    }
}

#[test]
fn the_request_timestamp_is_when_the_request_started() {
    let mut store = Store::default();
    ingest_all(&mut store, r#"[{ "type": "log", "requestId": "a", "value": "first", "timestamp": "2025-09-27T20:45:30.250000Z" }]"#);

    // until the request message arrives we only know when we first heard of it
    let summary = store.get("a").unwrap().summary();
    assert_eq!(summary["timestamp"], 1000);
    assert_eq!(summary["startedAt"], Value::Null);

    ingest_all(&mut store, r#"[{ "type": "request", "requestId": "a", "timestamp": "2025-09-27T20:45:30Z" }]"#);

    let summary = store.get("a").unwrap().summary();
    assert_eq!(summary["timestamp"], 1_759_005_930_000_000_u64);
    assert_eq!(summary["startedAt"], 1_759_005_930_000_000_u64);
}

#[test]
fn keeps_the_cachegrind_path_when_the_request_was_profiled() {
    let mut store = Store::default();
    ingest_all(
        &mut store,
        r#"[
            { "type": "request", "requestId": "a", "method": "GET", "cachegrind": "/tmp/cachegrind.out.1.gz" },
            { "type": "request", "requestId": "b", "method": "GET" }
        ]"#,
    );

    let profiled = store.get("a").unwrap();
    assert_eq!(profiled.cachegrind(), Some("/tmp/cachegrind.out.1.gz"));
    assert_eq!(profiled.summary()["cachegrind"], "/tmp/cachegrind.out.1.gz");

    let unprofiled = store.get("b").unwrap();
    assert_eq!(unprofiled.cachegrind(), None);
    assert_eq!(unprofiled.summary()["cachegrind"], Value::Null);
}

fn ingest_sentry(store: &mut Store, envelope: &str) -> Vec<u64> {
    crate::spotlight::parse_envelope(envelope.as_bytes())
        .unwrap()
        .into_iter()
        .filter_map(|event| store.add_exception(crate::spotlight::event_to_exception(event), 1000))
        .collect()
}

#[test]
fn exceptions_are_kept_apart_from_requests() {
    let mut store = Store::default();
    let added = ingest_sentry(&mut store, include_str!("../../tests/fixtures/sentry-exception.envelope"));

    assert_eq!(added, [1]);
    assert!(store.all().is_empty());

    let exception = store.exception(1).unwrap();
    assert_eq!(exception["source"], "sentry");
    assert_eq!(exception["label"], "RuntimeException");
    assert_eq!(exception["timestamp"], 1_791_714_928_518_759u64);
    assert_eq!(exception["raw"]["exception"]["values"][1]["type"], "RuntimeException");

    // the sidebar only needs the summary
    assert!(store.exceptions()[0].get("raw").is_none());
}

#[test]
fn the_sentry_trace_id_is_not_kept_with_the_request() {
    let mut store = Store::default();
    ingest_all(
        &mut store,
        r#"[
            { "type": "request", "requestId": "a", "method": "GET", "url": "/", "sentryTraceId": "abc" },
            { "type": "error", "requestId": "a", "value": "Something broke", "sentryTraceId": "abc" }
        ]"#,
    );

    assert!(store.get("a").unwrap().messages()[0].get("sentryTraceId").is_none());
}

#[test]
fn removes_a_single_exception() {
    let mut store = Store::default();
    ingest_sentry(&mut store, include_str!("../../tests/fixtures/sentry-message.envelope"));
    ingest_sentry(&mut store, include_str!("../../tests/fixtures/sentry-exception.envelope"));

    store.remove_exception(1);

    assert!(store.exception(1).is_none());
    assert_eq!(store.exceptions().len(), 1);
    assert_eq!(store.exceptions()[0]["id"], 2);
}

#[test]
fn clearing_exceptions_leaves_requests_alone() {
    let mut store = Store::default();
    ingest_all(&mut store, r#"[{ "type": "request", "requestId": "a", "method": "GET", "url": "/" }]"#);
    ingest_sentry(&mut store, include_str!("../../tests/fixtures/sentry-message.envelope"));

    store.clear_exceptions();

    assert!(store.exceptions().is_empty());
    assert_eq!(store.all().len(), 1);

    // ids carry on, so the ui never confuses a new exception with one it has cleared
    assert_eq!(ingest_sentry(&mut store, include_str!("../../tests/fixtures/sentry-message.envelope")), [2]);
}

#[test]
fn accepts_sentry_envelopes_over_http() {
    let app = tauri::test::mock_app();
    app.manage(AppState::default());

    let app = app.handle();
    let port = unused_port();
    app.state::<AppState>().settings.lock().unwrap().port = port;
    restart(app);

    let envelope = include_str!("../../tests/fixtures/sentry-exception.envelope");
    let (head, body) = envelope.split_at(envelope.len() / 2);

    // sent in two parts, to show the body is read until it is all there
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    write!(stream, "POST /stream HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/x-sentry-envelope\r\nContent-Length: {}\r\n\r\n{head}", envelope.len()).unwrap();
    stream.flush().unwrap();
    thread::sleep(Duration::from_millis(50));
    stream.write_all(body.as_bytes()).unwrap();

    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    assert!(response.starts_with("HTTP/1.1 200 OK\r\n"), "{response}");

    // the envelope is handled after the response goes out
    for _ in 0..50 {
        if !app.state::<AppState>().store.lock().unwrap().exceptions().is_empty() {
            break;
        }
        thread::sleep(Duration::from_millis(10));
    }

    let state = app.state::<AppState>();
    let store = state.store.lock().unwrap();
    assert_eq!(store.exceptions()[0]["label"], "RuntimeException");
}

#[test]
fn answers_http_requests_it_does_not_handle() {
    let app = tauri::test::mock_app();
    app.manage(AppState::default());

    let app = app.handle();
    let port = unused_port();
    app.state::<AppState>().settings.lock().unwrap().port = port;
    restart(app);

    for (request, status) in [
        ("OPTIONS /stream HTTP/1.1\r\nOrigin: http://localhost\r\n\r\n", "204 No Content"),
        ("GET / HTTP/1.1\r\n\r\n", "404 Not Found"),
        ("POST /stream HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n", "400 Bad Request"),
    ] {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream.write_all(request.as_bytes()).unwrap();

        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        assert!(response.starts_with(&format!("HTTP/1.1 {status}\r\n")), "{response}");
    }
}
