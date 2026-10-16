# echobug protocol

**Version 1**

This is the specification for sending data to echobug: what to connect to, how to frame it, and the messages echobug accepts. It is written for anyone building a client library. Each message is defined twice: once as a TypeScript-style type, which is the authoritative definition, and once as a JSON example that can be sent as it is.

echobug enforces everything here. A message that doesn't follow this specification is rejected, and the reason is shown in echobug's Payloads window (the `{ }` "Raw payloads" button at the top right).

Sentry SDKs can also send to echobug, through Sentry's own Spotlight protocol. See [Sentry SDKs (Spotlight)](#sentry-sdks-spotlight).

## Quick start

Open a TCP connection to `127.0.0.1:3000`, and write one JSON message per line:

```
{"type":"request","requestId":"7f3c","timestamp":"2026-10-11T10:35:28.400000Z","method":"GET","url":"https://localhost/users","status":200,"duration":23985,"memory":34076}
{"type":"log","requestId":"7f3c","timestamp":"2026-10-11T10:35:28.412000Z","value":"Loaded 3 users","file":"app/Http/Controllers/UserController.php","line":24}
{"type":"query","requestId":"7f3c","timestamp":"2026-10-11T10:35:28.409000Z","query":"SELECT * FROM users WHERE active = ?","parameters":[true],"rowsAffected":3,"duration":1250}
```

This creates one request in echobug's sidebar, with one message and one query.

## Transport

- **Connection.** TCP, to the host and port set in echobug's settings. The default is `127.0.0.1:3000`, which only accepts connections from the same machine. A client can keep one connection open for as long as it likes, or open a new one each time. Any number of clients can be connected at once.
- **Direction.** Data only flows from the client to echobug. echobug never writes anything back.
- **Encoding.** UTF-8.

### Framing

The stream is [newline-delimited JSON](https://github.com/ndjson/ndjson-spec):

- Every line is either a single message object, or an array of message objects (a batch).
- Every line ends with `\n`. A message must not contain a raw newline, so encode JSON without pretty-printing (newlines inside strings are escaped as `\n`, which is fine).
- Blank lines are ignored.
- A line can be split across any number of writes. echobug waits for the newline before reading it.

### Errors

- **A line that isn't valid JSON** closes the connection. Anything already read is kept, and anything after the bad line is lost. Reconnect to carry on.
- **A message that breaks this specification** is rejected on its own. The other messages on the same line, and in the same batch, are still accepted, and the connection stays open.
- **A line that never ends** is dropped when the connection closes. It also closes the connection if it grows past 64 MiB.

Rejections are written to echobug's log, and shown in the Payloads window with the reason, as long as that window is open.

## Rules for every message

1. `type`, `requestId` and `timestamp` are required on every message.
2. `type` is one of `request`, `log`, `info`, `warn`, `error` or `query`. Any other type is rejected.
3. `requestId` is a non-empty string that identifies the request the message belongs to. Every message for the same request uses the same `requestId`. A UUID is a good choice.
4. `timestamp` is when the message's information was captured, as a UTC time in the form `YYYY-MM-DDTHH:MM:SS[.fraction]Z`: always UTC, always ending in `Z`, with up to 9 fractional digits (echobug keeps microseconds). For example `2026-10-11T10:35:28.400000Z`. Offsets like `+01:00`, and numbers such as epoch milliseconds, are rejected.
5. Optional fields can be left out, but they can't be `null`. If there's nothing to send, leave the field out. `null` is only allowed as data: as a context value, and inside query parameters and query results.
6. A field that isn't in this specification is rejected, so a typo like `durations` is caught straight away rather than being silently ignored.
7. Durations are integer **microseconds**, and memory is integer **bytes**.

## Types

These types are the definition of the protocol. `integer` means a JSON number with no fractional part. A `?` marks an optional field, which can be left out but can't be `null`.

```ts
type Message = RequestMessage | LogMessage | QueryMessage;

/** e.g. "2026-10-11T10:35:28.400000Z" - always UTC, always ending in "Z", up to 9 fractional digits */
type Timestamp = string;

/** any JSON value, null included - used for query parameters and results */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * The summary of a request. It can be sent any number of times for the same requestId: each field that is sent
 * replaces the stored value, and fields that are left out keep their value. See "Requests are built up over time".
 */
interface RequestMessage {
    type: "request";
    requestId: string;
    timestamp: Timestamp;

    /** when the request started - message and query times are shown relative to it. Until one is sent, echobug uses the earliest timestamp of any of the request's messages - see "Start time" */
    startTime?: Timestamp;
    /** an id received from upstream (e.g. an X-Correlation-ID header), for relating requests - stored for future use */
    correlationId?: string;
    /** e.g. "GET" */
    method?: string;
    /** the full url, e.g. "https://localhost/users?page=2" - the sidebar shows its path */
    url?: string;
    /** the http status code of the response, 100 to 599 */
    status?: integer;
    /** how long the request took, in microseconds */
    duration?: integer;
    /** peak memory used, in bytes */
    memory?: integer;
    /** absolute path to an xdebug cachegrind profile of the request - echobug reads it to draw a flamegraph, so it only works when echobug runs on the same machine */
    cachegrind?: string;
    /** sections of the Context tab, by section key - see "Context" */
    context?: { [sectionKey: string]: ContextSection };
}

interface ContextSection {
    /** shown as the section's heading - the section key is shown when there's no label */
    label?: string;
    /** sections are shown lowest order first - sections without an order come last */
    order?: integer;
    /** the rows of the section, one value each - to show an object or array, JSON-encode it into a string and echobug will show it as highlighted JSON */
    values: { [key: string]: string | number | boolean | null };
}

/** A line in the Messages tab. The four types only differ in how they are shown and filtered. */
interface LogMessage {
    type: "log" | "info" | "warn" | "error";
    requestId: string;
    timestamp: Timestamp;

    /** the message itself - to send structured data, JSON-encode it into this string and echobug will show it as highlighted JSON */
    value: string;
    /** a short title shown before the value */
    label?: string;
    /** the file the message came from, relative to the project root */
    file?: string;
    /** the line in that file, from 1 */
    line?: integer;
}

/** A database query, shown in the Queries tab. */
interface QueryMessage {
    type: "query";
    requestId: string;
    timestamp: Timestamp;

    /** the sql, as it was sent to the database */
    query: string;
    /** the bound values - by name, or in order for positional "?" placeholders */
    parameters?: { [name: string]: JsonValue } | JsonValue[];
    /** the rows that came back, each an object of column to value */
    results?: { [column: string]: JsonValue }[];
    /** how many rows were returned or changed */
    rowsAffected?: integer;
    /** how long the query took, in microseconds */
    duration?: integer;
    /** memory used by the query, in bytes */
    memory?: integer;
}
```

## Messages

The examples are shown spread over several lines so they're easier to read. On the wire, each one has to be written on a single line.

### `request`

The summary of a request: what it was, how it ended, and its context.

```json
{
    "type": "request",
    "requestId": "f7d7c15c-873c-470f-9bd6-59b94f00bdbf",
    "timestamp": "2026-10-11T10:35:28.424000Z",
    "startTime": "2026-10-11T10:35:28.400000Z",
    "correlationId": "b07af512-11a0-4f21-b881-5575da389326",
    "method": "GET",
    "url": "https://localhost/api/v1/users?page=1",
    "status": 200,
    "duration": 23985,
    "memory": 34076,
    "context": {
        "request-headers": {
            "label": "Request Headers",
            "order": 1,
            "values": { "Accept": "*/*", "User-Agent": "curl/8.4.0" }
        },
        "user": {
            "label": "User",
            "order": 2,
            "values": { "id": 123, "admin": true, "roles": "[\"admin\",\"editor\"]" }
        }
    }
}
```

#### Requests are built up over time

- **Any order.** Messages for a request can arrive before its `request` message. echobug shows the request as pending until its summary arrives. This lets a client stream messages and queries as they happen, and send the summary when the request finishes.
- **Updates.** A `request` message can be sent more than once for the same `requestId`. Each field that is sent replaces the stored value, and fields that are left out keep the value they had. For example, a client can send `method` and `url` when the request starts, and `status`, `duration` and `memory` when it ends.
- **Context is merged.** Each section in `context` is merged with the section of the same key that echobug already has: `label` and `order` replace the stored ones if they're sent, and each key in `values` replaces the value stored under that key. Sections and values can only be added or changed, never removed.
- **Start time.** The start of a request is the `startTime` it was sent with, and like any other field, a later `startTime` replaces an earlier one. Until a `startTime` is sent, echobug uses the earliest `timestamp` of any of the request's messages, of any type, and updates it as messages arrive. A `startTime` always wins once it has been sent, even over earlier timestamps. The start is the time shown in the sidebar, and message and query times are shown relative to it. So a client only needs to send `startTime` when the request really started before its first message.
- **Removed requests.** When the user removes a request in echobug, or clears them all, any later messages with that `requestId` are ignored, so it doesn't reappear.

#### Context

The Context tab shows each section as a heading with its rows underneath, which can be collapsed:

- Sections are shown in ascending `order`, and sections with no `order` come after the rest. Sections with the same `order` are shown in order of their section key.
- Within a section, the values are shown sorted by key.
- Each value is a single string, number, boolean or `null`, and is shown as it is. Objects and arrays are rejected: JSON-encode them into a string instead, and echobug shows any string that holds a JSON object or array as pretty-printed, highlighted JSON, as it does for message values.

### `log`, `info`, `warn` and `error`

A message, like a line written to the browser console. The four types look the same, apart from their colour, and the Messages tab can be filtered by type.

```json
{
    "type": "warn",
    "requestId": "f7d7c15c-873c-470f-9bd6-59b94f00bdbf",
    "timestamp": "2026-10-11T10:35:28.412000Z",
    "label": "Cache",
    "value": "Cache miss for users:page:1",
    "file": "app/Repositories/UserRepository.php",
    "line": 42
}
```

To send structured data, encode it as JSON inside `value`. echobug pretty-prints and highlights any `value` that is a JSON object or array:

```json
{
    "type": "log",
    "requestId": "f7d7c15c-873c-470f-9bd6-59b94f00bdbf",
    "timestamp": "2026-10-11T10:35:28.415000Z",
    "label": "Payload",
    "value": "{\"name\":\"John\",\"age\":30}"
}
```

### `query`

A database query, with its bindings and results.

```json
{
    "type": "query",
    "requestId": "f7d7c15c-873c-470f-9bd6-59b94f00bdbf",
    "timestamp": "2026-10-11T10:35:28.409000Z",
    "query": "SELECT * FROM users WHERE active = ? AND created_at > ?",
    "parameters": [true, "2025-01-01"],
    "results": [
        { "id": 1, "name": "John Doe", "active": true },
        { "id": 2, "name": "Jane Smith", "active": true }
    ],
    "rowsAffected": 2,
    "duration": 1250,
    "memory": 2048
}
```

`parameters` can also be named, for `:name` placeholders: `{ "active": true, "created_at": "2025-01-01" }`.

## Sentry SDKs (Spotlight)

echobug also stands in for [Sentry Spotlight](https://spotlightjs.com/). Point a Sentry SDK's Spotlight URL at echobug, and the events it captures (exceptions and messages) show up in echobug's Exceptions view:

```
http://127.0.0.1:3000/stream
```

This uses the same port as the TCP protocol, because echobug can tell an HTTP request from a stream of JSON. The SDK sends standard [Sentry envelopes](https://develop.sentry.dev/sdk/data-model/envelopes/), which echobug reads as they are. Nothing in this document applies to them. Only `event` items are used: transactions, sessions and attachments are skipped. Bodies must not be compressed or chunked, which matches what Spotlight clients send.
