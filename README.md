# echobug

echobug listens for events sent to it from a server application and displays them - think chrome console for a server application.

## Running

```sh
npm install
npm run tauri dev
```

## Sending messages

echobug listens on TCP port `3000` (localhost only) for JSON. Each payload is an array of one or more message objects, and every message needs a `type`, `requestId` and `correlationId`:

| type | purpose |
| --- | --- |
| `request` | describes the request itself - `method`, `url`, `status`, `duration` (µs), `memory` (bytes) and `variables` (shown on the Context tab) |
| `log`, `info`, `warn`, `error` | a message for the Messages tab - `value`, and optionally `label`, `file` and `line` |
| `query` | a query for the Queries tab - `query`, and optionally `parameters`, `rowsAffected`, `duration`, `memory` and `results` |

Messages are grouped by `requestId`, and can arrive in any order and across any number of payloads or connections.

Examples can be found in `old/examples`, and can be sent with:

```sh
nc -q1 localhost 3000 < old/examples/messages.json
```
