use super::*;

// every example has to be valid - what gets rejected is tested with the protocol
fn ingest_all(store: &mut Store, payload: &str) -> Vec<Option<String>> {
    let Value::Array(messages) = serde_json::from_str(payload).unwrap() else {
        panic!("example payload should be an array");
    };
    messages.into_iter().map(|message| store.ingest(protocol::parse(message).unwrap())).collect()
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

    // the utc timestamp the client sent becomes epoch microseconds
    assert_eq!(requests[0].messages()[0]["timestamp"], 1_759_005_930_001_000_u64);
    assert_eq!(requests[0].messages()[0]["type"], "log");
}

#[test]
fn separates_queries_from_messages() {
    let mut store = Store::default();
    ingest_all(&mut store, include_str!("../../tests/fixtures/queries.json"));

    let request = store.all()[0];
    assert_eq!(request.queries().len(), 8);
    assert!(request.messages().is_empty());

    assert_eq!(request.queries()[0]["timestamp"], 1_759_005_930_000_000_u64);
    assert_eq!(request.queries()[0]["type"], "query");
}

#[test]
fn keeps_requests_in_arrival_order() {
    let mut store = Store::default();
    ingest_all(&mut store, include_str!("../../tests/fixtures/request-methods.json"));

    let methods: Vec<Value> = store.all().iter().map(|request| request.summary()["method"].clone()).collect();
    assert_eq!(methods, ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS", "CONNECT"]);
}

#[test]
fn stores_the_context() {
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
            { "type": "log", "requestId": "a", "timestamp": "2025-09-27T20:45:30.100000Z", "value": "before the request" },
            { "type": "request", "requestId": "a", "timestamp": "2025-09-27T20:45:30Z", "correlationId": "b", "method": "GET", "url": "/", "context": { "one": { "label": "One", "values": { "x": "1" } } } },
            { "type": "request", "requestId": "a", "timestamp": "2025-09-27T20:45:30Z", "correlationId": "c", "status": 200, "context": { "one": { "order": 2, "values": { "x": 3, "y": null } } } }
        ]"#,
    );

    let request = store.get("a").unwrap();
    let summary = request.summary();
    assert_eq!(summary["method"], "GET");
    assert_eq!(summary["status"], 200);
    assert_eq!(summary["correlationId"], "c");
    assert_eq!(summary["messagesCount"], 1);

    // sections are merged key by key, a value can change type, and null is data like any other
    assert_eq!(request.context()["one"], json!({ "label": "One", "order": 2, "values": { "x": 3, "y": null } }));
}

#[test]
fn removed_requests_stay_removed() {
    let mut store = Store::default();
    ingest_all(&mut store, r#"[{ "type": "request", "requestId": "a", "timestamp": "2025-09-27T20:45:30Z" }]"#);
    store.remove("a");

    let changed = ingest_all(&mut store, r#"[{ "type": "log", "requestId": "a", "timestamp": "2025-09-27T20:45:30Z", "value": "late" }]"#);
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
fn the_start_is_the_earliest_timestamp_until_a_start_time_is_sent() {
    let mut store = Store::default();
    let start = |store: &Store| store.get("a").unwrap().summary()["startedAt"].clone();

    // a message can arrive before its request, and it is all there is to go on
    ingest_all(&mut store, r#"[{ "type": "log", "requestId": "a", "timestamp": "2025-09-27T20:45:30.250000Z", "value": "first" }]"#);
    assert_eq!(start(&store), 1_759_005_930_250_000_u64);

    // anything earlier, whatever its type, moves the start back
    ingest_all(
        &mut store,
        r#"[
            { "type": "request", "requestId": "a", "timestamp": "2025-09-27T20:45:30.300000Z", "method": "GET" },
            { "type": "query", "requestId": "a", "timestamp": "2025-09-27T20:45:30.100000Z", "query": "SELECT 1" }
        ]"#,
    );
    assert_eq!(start(&store), 1_759_005_930_100_000_u64);

    // a start time wins, even over earlier timestamps, and a later one replaces it
    ingest_all(&mut store, r#"[{ "type": "request", "requestId": "a", "timestamp": "2025-09-27T20:45:31Z", "startTime": "2025-09-27T20:45:30.200000Z" }]"#);
    assert_eq!(start(&store), 1_759_005_930_200_000_u64);

    ingest_all(&mut store, r#"[{ "type": "log", "requestId": "a", "timestamp": "2025-09-27T20:45:29Z", "value": "earlier still" }]"#);
    assert_eq!(start(&store), 1_759_005_930_200_000_u64);

    ingest_all(&mut store, r#"[{ "type": "request", "requestId": "a", "timestamp": "2025-09-27T20:45:31Z", "startTime": "2025-09-27T20:45:30Z" }]"#);
    assert_eq!(start(&store), 1_759_005_930_000_000_u64);

    // a follow up without one leaves it alone
    ingest_all(&mut store, r#"[{ "type": "request", "requestId": "a", "timestamp": "2025-09-27T20:45:32Z", "status": 200 }]"#);
    assert_eq!(start(&store), 1_759_005_930_000_000_u64);
}

#[test]
fn keeps_the_cachegrind_path_when_the_request_was_profiled() {
    let mut store = Store::default();
    ingest_all(
        &mut store,
        r#"[
            { "type": "request", "requestId": "a", "timestamp": "2025-09-27T20:45:30Z", "method": "GET", "cachegrind": "/tmp/cachegrind.out.1.gz" },
            { "type": "request", "requestId": "b", "timestamp": "2025-09-27T20:45:30Z", "method": "GET" }
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
    ingest_all(&mut store, r#"[{ "type": "request", "requestId": "a", "timestamp": "2025-09-27T20:45:30Z", "method": "GET", "url": "/" }]"#);
    ingest_sentry(&mut store, include_str!("../../tests/fixtures/sentry-message.envelope"));

    store.clear_exceptions();

    assert!(store.exceptions().is_empty());
    assert_eq!(store.all().len(), 1);

    // ids carry on, so the ui never confuses a new exception with one it has cleared
    assert_eq!(ingest_sentry(&mut store, include_str!("../../tests/fixtures/sentry-message.envelope")), [2]);
}

#[test]
fn reads_newline_delimited_json_and_rejects_messages_one_at_a_time() {
    let app = tauri::test::mock_app();
    app.manage(AppState::default());

    let app = app.handle();
    let port = unused_port();
    app.state::<AppState>().settings.lock().unwrap().port = port;
    restart(app);

    // a line can arrive in pieces, and a batch keeps the messages that are valid
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream.write_all(br#"{ "type": "request", "requestId": "a", "timestamp": "2025-09-27T20:45:30Z", "#).unwrap();
    stream.flush().unwrap();
    thread::sleep(Duration::from_millis(50));
    stream.write_all(br#""method": "GET" }"#).unwrap();
    stream.write_all(b"\n").unwrap();
    stream.write_all(br#"[{ "type": "log", "requestId": "a", "timestamp": "2025-09-27T20:45:30Z", "value": "kept" }, { "type": "log", "requestId": "a", "value": "no timestamp" }]"#).unwrap();
    stream.write_all(b"\n").unwrap();

    // a line that isn't json closes the connection, so the line after it is never read
    stream.write_all(b"{ not json\n").unwrap();
    let _ = stream.write_all(br#"{ "type": "log", "requestId": "a", "timestamp": "2025-09-27T20:45:30Z", "value": "too late" }"#);
    let _ = stream.write_all(b"\n");

    let mut rest = Vec::new();
    let _ = stream.read_to_end(&mut rest);

    let state = app.state::<AppState>();
    let store = state.store.lock().unwrap();
    let request = store.get("a").unwrap();
    assert_eq!(request.summary()["method"], "GET");
    assert_eq!(request.messages().iter().map(|message| message["value"].clone()).collect::<Vec<_>>(), ["kept"]);
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

fn rejection(n: u64) -> Value {
    json!({ "raw": n.to_string() })
}

#[test]
fn rejections_wait_until_the_payloads_window_is_listening() {
    let mut window = PayloadsWindow::default();

    assert!(!window.queue(rejection(1)));
    assert!(!window.queue(rejection(2)));
    assert_eq!(window.take(), vec![rejection(1), rejection(2)]);

    // once it is listening they go straight to it
    assert!(window.queue(rejection(3)));
    assert_eq!(window.take(), Vec::<Value>::new());
}

#[test]
fn only_the_most_recent_rejections_wait() {
    let mut window = PayloadsWindow::default();

    for n in 0..MAX_PENDING_PAYLOADS as u64 + 10 {
        window.queue(rejection(n));
    }

    let pending = window.take();
    assert_eq!(pending.len(), MAX_PENDING_PAYLOADS);
    assert_eq!(pending[0], rejection(10));
    assert_eq!(pending.last(), Some(&rejection(MAX_PENDING_PAYLOADS as u64 + 9)));
}

#[test]
fn closing_the_payloads_window_stops_it_listening() {
    let mut window = PayloadsWindow::default();
    window.take();

    window.closed();
    assert!(!window.queue(rejection(1)));

    window.closed();
    assert_eq!(window.take(), Vec::<Value>::new());
}
