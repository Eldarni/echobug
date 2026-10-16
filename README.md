# echobug

echobug is a desktop app that shows you what your server application is doing while it runs - think of it as the Chrome console, but for the server.

Your application sends echobug details about each request it handles, such as log messages, database queries and errors, and echobug shows them grouped by request. You don't need to dig through log files or sprinkle debugging output through your responses.

## Features

- **Requests** - every request your application handles appears in the sidebar as it happens, with its method, path, status and time.
- **Context** - request and response headers, query parameters, cookies, session details and anything else your application chooses to share about a request.
- **Messages** - log, info, warning and error messages, with the file and line they came from. JSON is pretty printed and highlighted.
- **Queries** - every database query run during the request, with its parameters, results, timing and memory use.
- **Flamegraphs** - supports rendering of cachegrind files as a flamegraph (currently only on local servers only)
- **Exceptions** - acts as a replacement for sentry spotlight - exceptions and messages from a Sentry SDK show up in their own view with their associated context and trace

## Getting started

To run echobug from source you'll need [Node.js](https://nodejs.org/), [Rust](https://www.rust-lang.org/tools/install) and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your platform. Then:

```sh
npm install
npm run tauri dev
```

To build an installable app for your platform instead:

```sh
npm run tauri build
```

Once echobug is open, it waits for your application to connect. By default it listens on port `3000`, and only accepts connections from the same machine.

## AI declaration

Parts of echobug were written with the help of AI coding tools, including Claude by Anthropic. This includes the original port of echobug from a VS Code extension to a desktop app, as well as some of its features, tests and documentation.

AI-assisted code is directed by, and its use is the responsibility of, the project's author, in the same way as any other contribution.
