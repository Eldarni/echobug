use serde_json::json;

use super::*;

const FIXTURES: [&str; 4] = [
    include_str!("../../tests/fixtures/messages.json"),
    include_str!("../../tests/fixtures/queries.json"),
    include_str!("../../tests/fixtures/request-methods.json"),
    include_str!("../../tests/fixtures/request-variables.json"),
];

fn rejection(message: Value) -> String {
    parse(message).expect_err("the message should have been rejected")
}

#[test]
fn every_fixture_follows_the_protocol() {
    for fixture in FIXTURES {
        let Value::Array(messages) = serde_json::from_str(fixture).unwrap() else {
            panic!("fixtures should be arrays");
        };
        for message in messages {
            if let Err(err) = parse(message.clone()) {
                panic!("{err}: {message}");
            }
        }
    }
}

// the quick start's lines, and every ```json block that is a message, have to be accepted as they are - the blocks
// are spread over several lines to be readable, which json doesn't mind
#[test]
fn every_example_in_the_specification_follows_the_protocol() {
    let specification = include_str!("../../../PROTOCOL.md");

    let mut examples = Vec::new();
    let mut block: Option<(String, String)> = None;
    for line in specification.lines() {
        match &mut block {
            None if line.starts_with("```") => block = Some((line.trim_start_matches('`').to_owned(), String::new())),
            None => {}
            Some((language, text)) if line.starts_with("```") => {
                match language.as_str() {
                    "json" => examples.push(std::mem::take(text)),
                    "" => examples.extend(text.lines().filter(|line| line.starts_with('{')).map(str::to_owned)),
                    _ => {}
                }
                block = None;
            }
            Some((_, text)) => {
                text.push_str(line);
                text.push('\n');
            }
        }
    }

    assert!(examples.len() >= 7, "only found {} examples", examples.len());
    for example in examples {
        let message: Value = serde_json::from_str(&example).unwrap_or_else(|err| panic!("{err}: {example}"));
        if let Err(err) = parse(message) {
            panic!("{err}: {example}");
        }
    }
}

#[test]
fn reads_each_type_of_message() {
    let timestamp = "2025-09-27T20:45:30Z";

    assert!(matches!(parse(json!({ "type": "request", "requestId": "a", "timestamp": timestamp })), Ok(Message::Request(_))));
    assert!(matches!(parse(json!({ "type": "log", "requestId": "a", "timestamp": timestamp, "value": "hi" })), Ok(Message::Log(_))));
    assert!(matches!(parse(json!({ "type": "info", "requestId": "a", "timestamp": timestamp, "value": "hi" })), Ok(Message::Info(_))));
    assert!(matches!(parse(json!({ "type": "warn", "requestId": "a", "timestamp": timestamp, "value": "hi" })), Ok(Message::Warn(_))));
    assert!(matches!(parse(json!({ "type": "error", "requestId": "a", "timestamp": timestamp, "value": "hi" })), Ok(Message::Error(_))));
    assert!(matches!(parse(json!({ "type": "query", "requestId": "a", "timestamp": timestamp, "query": "SELECT 1" })), Ok(Message::Query(_))));
}

#[test]
fn context_values_can_be_any_json_scalar() {
    let message = json!({
        "type": "request",
        "requestId": "a",
        "timestamp": "2025-09-27T20:45:30Z",
        "startTime": "2025-09-27T20:45:29.5Z",
        "context": { "one": { "values": { "string": "hi", "integer": 1, "float": 1.5, "boolean": true, "null": null, "json": "{\"id\":1}" } } },
    });

    let Ok(Message::Request(request)) = parse(message) else {
        panic!("the request should have been accepted");
    };
    assert_eq!(request.start_time, Some(1_759_005_929_500_000));
    assert_eq!(request.context.unwrap()["one"].values.len(), 6);
}

#[test]
fn query_parameters_can_be_named_or_positional() {
    for parameters in [json!({ "id": 1 }), json!([1, "two"])] {
        let message = json!({ "type": "query", "requestId": "a", "timestamp": "2025-09-27T20:45:30Z", "query": "SELECT ?", "parameters": parameters });
        assert!(parse(message).is_ok(), "{parameters}");
    }
}

// a valid log message, changed in one way
fn log_with(changes: Value) -> Value {
    let mut message = json!({ "type": "log", "requestId": "a", "timestamp": "2025-09-27T20:45:30Z", "value": "hi" });
    for (key, value) in changes.as_object().unwrap() {
        message[key] = value.clone();
    }
    message
}

fn log_without(key: &str) -> Value {
    let mut message = log_with(json!({}));
    message.as_object_mut().unwrap().remove(key);
    message
}

#[test]
fn rejects_messages_that_break_the_protocol() {
    for (message, reason) in [
        (json!("not an object"), "json object"),
        (log_without("type"), "missing field `type`"),
        (log_with(json!({ "type": "timeline" })), "unknown variant `timeline`"),
        (log_without("requestId"), "missing field `requestId`"),
        (log_with(json!({ "requestId": 1 })), "invalid type: integer"),
        (log_with(json!({ "requestId": "" })), "can't be empty"),
        (log_without("timestamp"), "missing field `timestamp`"),
        (log_with(json!({ "timestamp": "2025-09-27T20:45:30+03:00" })), "not a utc time"),
        (log_with(json!({ "timestamp": 1759005930000u64 })), "invalid type: integer"),
        (log_without("value"), "missing field `value`"),
        (log_with(json!({ "value": { "structured": true } })), "invalid type: map"),
        (log_with(json!({ "line": 0 })), "invalid value"),
        (log_with(json!({ "label": null })), "invalid type: null"),
        (log_with(json!({ "correlationId": "b" })), "unknown field `correlationId`"),
        (log_with(json!({ "durations": 5 })), "unknown field `durations`"),
        (json!({ "type": "request", "requestId": "a", "timestamp": "2025-09-27T20:45:30Z", "variables": {} }), "unknown field `variables`"),
        (json!({ "type": "request", "requestId": "a", "timestamp": "2025-09-27T20:45:30Z", "status": 99 }), "not an http status code"),
        (json!({ "type": "request", "requestId": "a", "timestamp": "2025-09-27T20:45:30Z", "method": null }), "invalid type: null"),
        (json!({ "type": "request", "requestId": "a", "timestamp": "2025-09-27T20:45:30Z", "context": { "one": { "label": "One" } } }), "missing field `values`"),
        (json!({ "type": "request", "requestId": "a", "timestamp": "2025-09-27T20:45:30Z", "context": { "one": { "values": {}, "colour": "red" } } }), "unknown field `colour`"),
        (json!({ "type": "request", "requestId": "a", "timestamp": "2025-09-27T20:45:30Z", "startTime": "2025-09-27 20:45:30Z" }), "not a utc time"),
        (json!({ "type": "request", "requestId": "a", "timestamp": "2025-09-27T20:45:30Z", "startTime": null }), "invalid type: null"),
        (json!({ "type": "request", "requestId": "a", "timestamp": "2025-09-27T20:45:30Z", "version": 1 }), "unknown field `version`"),
        (json!({ "type": "request", "requestId": "a", "timestamp": "2025-09-27T20:45:30Z", "context": { "one": { "values": { "roles": ["admin"] } } } }), "context value \"roles\""),
        (json!({ "type": "request", "requestId": "a", "timestamp": "2025-09-27T20:45:30Z", "context": { "one": { "values": { "user": { "id": 1 } } } } }), "encode objects and arrays as a json string"),
        (json!({ "type": "query", "requestId": "a", "timestamp": "2025-09-27T20:45:30Z" }), "missing field `query`"),
        (json!({ "type": "query", "requestId": "a", "timestamp": "2025-09-27T20:45:30Z", "query": "SELECT 1", "parameters": "1" }), "parameters to be an object or an array"),
        (json!({ "type": "query", "requestId": "a", "timestamp": "2025-09-27T20:45:30Z", "query": "SELECT 1", "results": [1] }), "invalid type: integer"),
    ] {
        let err = rejection(message.clone());
        assert!(err.contains(reason), "{message} was rejected with \"{err}\", expected \"{reason}\"");
    }
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
