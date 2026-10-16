// the messages echobug's own clients send over tcp - PROTOCOL.md is the specification, and this is where it is
// enforced, so anything the specification doesn't allow is rejected here with the reason
use std::collections::BTreeMap;
use std::num::NonZeroU32;

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Message {
    Request(RequestMessage),
    Log(LogMessage),
    Info(LogMessage),
    Warn(LogMessage),
    Error(LogMessage),
    Query(QueryMessage),
}

impl Message {
    pub fn request_id(&self) -> &str {
        match self {
            Message::Request(message) => &message.request_id,
            Message::Log(message) | Message::Info(message) | Message::Warn(message) | Message::Error(message) => &message.request_id,
            Message::Query(message) => &message.request_id,
        }
    }

    // when the message's information was captured, in epoch microseconds
    pub fn timestamp(&self) -> u64 {
        match self {
            Message::Request(message) => message.timestamp,
            Message::Log(message) | Message::Info(message) | Message::Warn(message) | Message::Error(message) => message.timestamp,
            Message::Query(message) => message.timestamp,
        }
    }
}

// the summary of a request - it can be sent more than once, and every field that is sent replaces what was there
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RequestMessage {
    #[serde(deserialize_with = "request_id")]
    pub request_id: String,
    #[serde(deserialize_with = "timestamp")]
    pub timestamp: u64,

    // when the request started - until one is sent, the earliest timestamp of any of the request's messages is used
    #[serde(default, deserialize_with = "optional_timestamp")]
    pub start_time: Option<u64>,
    #[serde(default, deserialize_with = "present")]
    pub correlation_id: Option<String>,
    #[serde(default, deserialize_with = "present")]
    pub method: Option<String>,
    #[serde(default, deserialize_with = "present")]
    pub url: Option<String>,
    #[serde(default, deserialize_with = "status")]
    pub status: Option<u16>,
    #[serde(default, deserialize_with = "present")]
    pub duration: Option<u64>,
    #[serde(default, deserialize_with = "present")]
    pub memory: Option<u64>,
    #[serde(default, deserialize_with = "present")]
    pub cachegrind: Option<String>,
    #[serde(default, deserialize_with = "present")]
    pub context: Option<BTreeMap<String, Section>>,
}

// a group of values in the context tab
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Section {
    #[serde(default, deserialize_with = "present")]
    pub label: Option<String>,
    #[serde(default, deserialize_with = "present")]
    pub order: Option<i64>,
    #[serde(deserialize_with = "context_values")]
    pub values: Map<String, Value>,
}

// log, info, warn and error all look the same - the type is all that differs
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LogMessage {
    #[serde(deserialize_with = "request_id")]
    pub request_id: String,
    #[serde(deserialize_with = "timestamp")]
    pub timestamp: u64,

    pub value: String,
    #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
    pub line: Option<NonZeroU32>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueryMessage {
    #[serde(deserialize_with = "request_id")]
    pub request_id: String,
    #[serde(deserialize_with = "timestamp")]
    pub timestamp: u64,

    pub query: String,
    #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
    pub parameters: Option<Parameters>,
    #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
    pub results: Option<Vec<Map<String, Value>>>,
    #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
    pub rows_affected: Option<u64>,
    #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
    pub duration: Option<u64>,
    #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
    pub memory: Option<u64>,
}

// named bindings, or positional ones for "?" placeholders
#[derive(Debug, Deserialize, Serialize)]
#[serde(untagged, expecting = "parameters to be an object or an array")]
pub enum Parameters {
    Named(Map<String, Value>),
    Positional(Vec<Value>),
}

pub fn parse(message: Value) -> Result<Message, String> {
    if !message.is_object() {
        return Err("a message has to be a json object".into());
    }
    serde_json::from_value(message).map_err(|err| err.to_string())
}

// an optional field can be left out, but when it is sent it has to have a value - null means nothing
fn present<'de, D: Deserializer<'de>, T: Deserialize<'de>>(deserializer: D) -> Result<Option<T>, D::Error> {
    T::deserialize(deserializer).map(Some)
}

fn request_id<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    let request_id = String::deserialize(deserializer)?;
    if request_id.is_empty() {
        return Err(serde::de::Error::custom("requestId can't be empty"));
    }
    Ok(request_id)
}

fn timestamp<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
    let timestamp = String::deserialize(deserializer)?;
    parse_utc_micros(&timestamp).ok_or_else(|| serde::de::Error::custom(format!("timestamp \"{timestamp}\" is not a utc time like 2026-10-11T10:35:28.400000Z")))
}

fn optional_timestamp<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<u64>, D::Error> {
    timestamp(deserializer).map(Some)
}

// a row in the context tab holds a single value - structured data is sent as a json string, like a message's value
fn context_values<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Map<String, Value>, D::Error> {
    let values = Map::<String, Value>::deserialize(deserializer)?;
    if let Some((key, _)) = values.iter().find(|(_, value)| value.is_object() || value.is_array()) {
        return Err(serde::de::Error::custom(format!(
            "context value \"{key}\" has to be a string, number, boolean or null - encode objects and arrays as a json string"
        )));
    }
    Ok(values)
}

fn status<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<u16>, D::Error> {
    let status = u16::deserialize(deserializer)?;
    if !(100..=599).contains(&status) {
        return Err(serde::de::Error::custom(format!("status {status} is not an http status code")));
    }
    Ok(Some(status))
}

// parses "YYYY-MM-DDTHH:MM:SS[.fraction]Z" into epoch microseconds - utc only, anything else is rejected
pub fn parse_utc_micros(value: &str) -> Option<u64> {
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

#[cfg(test)]
mod tests;
