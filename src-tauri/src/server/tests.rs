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

    // messages without a timestamp get the time we received them
    assert_eq!(requests[0].messages()[0]["timestamp"], 1000);
}

#[test]
fn separates_queries_from_messages() {
    let mut store = Store::default();
    ingest_all(&mut store, include_str!("../../tests/fixtures/queries.json"));

    let request = store.all()[0];
    assert_eq!(request.queries().len(), 8);
    assert!(request.messages().is_empty());

    // a timestamp sent by the client is kept as is
    assert_eq!(request.queries()[0]["timestamp"], "2025-09-27T20:45:30Z");
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
