mod protocol;
mod server;
mod settings;
mod spotlight;

use serde_json::Value;
use tauri::ipc::Response;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use server::AppState;
use settings::{Settings, Theme};

#[tauri::command]
fn get_server_status(app: AppHandle) -> Value {
    server::status(&app)
}

#[tauri::command]
fn get_settings(state: State<AppState>) -> Settings {
    state.settings.lock().unwrap().clone()
}

// restarting the listener can block for a moment, so keep it off the main thread
#[tauri::command(async)]
fn save_settings(app: AppHandle, state: State<AppState>, settings: Settings) -> Result<Value, String> {
    settings.validate()?;
    settings::save(&app, &settings)?;

    let theme = settings.theme;
    let listener_changed = {
        let mut current = state.settings.lock().unwrap();
        let changed = current.host != settings.host || current.port != settings.port;
        *current = settings;
        changed
    };

    // only drop the listener when it actually needs to move
    if listener_changed {
        server::restart(&app);
    }

    apply_theme(&app, theme);

    Ok(server::status(&app))
}

// sets the native theme for title bars and window chrome, and tells every window so the pages can follow
fn apply_theme(app: &AppHandle, theme: Theme) {
    app.set_theme(match theme {
        Theme::System => None,
        Theme::Light => Some(tauri::Theme::Light),
        Theme::Dark => Some(tauri::Theme::Dark),
    });

    let _ = app.emit("theme-changed", theme);
}

// this has to be async, creating a window from a sync command deadlocks on windows
#[tauri::command]
async fn open_settings(app: AppHandle) -> Result<(), String> {
    open_window(&app, "settings", "settings.html", "echobug settings", (460.0, 340.0), false)
}

// shows payloads exactly as they arrive, for as long as the window is open
#[tauri::command]
async fn open_payloads(app: AppHandle) -> Result<(), String> {
    open_window(&app, server::PAYLOADS_WINDOW, "payloads.html", "echobug payloads", (900.0, 700.0), true)
}

// one window per profiled request, so profiles can be compared side by side
#[tauri::command]
async fn open_flamegraph(app: AppHandle, request_id: String) -> Result<(), String> {
    let label: String = request_id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect();
    let url = format!("flamegraph.html?requestId={}", encode_query_value(&request_id));
    open_window(&app, &format!("flamegraph-{label}"), &url, "echobug flamegraph", (1200.0, 700.0), true)
}

// the profile is looked up by request so the webview can't be used to read any file it likes - reading a large
// profile can take a moment, so keep it off the main thread
#[tauri::command(async)]
fn get_request_cachegrind(state: State<AppState>, request_id: String) -> Result<Response, String> {
    let path = {
        let store = state.store.lock().unwrap();
        let request = store.get(&request_id).ok_or("the request no longer exists")?;
        request.cachegrind().ok_or("the request was not profiled")?.to_owned()
    };

    std::fs::read(&path)
        .map(Response::new)
        .map_err(|err| format!("failed to read {path}: {err}"))
}

fn encode_query_value(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (byte as char).to_string(),
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

// focuses the window if it is already open, rather than opening a second one
fn open_window(app: &AppHandle, label: &str, url: &str, title: &str, (width, height): (f64, f64), resizable: bool) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.unminimize();
        return window.set_focus().map_err(|err| err.to_string());
    }

    WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
        .title(title)
        .inner_size(width, height)
        .resizable(resizable)
        .build()
        .map(|_| ())
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn get_all_requests(state: State<AppState>) -> Vec<Value> {
    let store = state.store.lock().unwrap();
    store.all().into_iter().map(|request| request.summary()).collect()
}

#[tauri::command]
fn get_request(state: State<AppState>, request_id: String) -> Option<Value> {
    let store = state.store.lock().unwrap();
    store.get(&request_id).map(|request| request.summary())
}

#[tauri::command]
fn get_request_context(state: State<AppState>, request_id: String) -> Option<Value> {
    let store = state.store.lock().unwrap();
    store.get(&request_id).map(|request| Value::Object(request.context().clone()))
}

#[tauri::command]
fn get_request_messages(state: State<AppState>, request_id: String) -> Option<Vec<Value>> {
    let store = state.store.lock().unwrap();
    store.get(&request_id).map(|request| request.messages().to_vec())
}

#[tauri::command]
fn get_request_queries(state: State<AppState>, request_id: String) -> Option<Vec<Value>> {
    let store = state.store.lock().unwrap();
    store.get(&request_id).map(|request| request.queries().to_vec())
}

#[tauri::command]
fn remove_request(state: State<AppState>, request_id: String) {
    state.store.lock().unwrap().remove(&request_id);
}

#[tauri::command]
fn clear_requests(state: State<AppState>) {
    state.store.lock().unwrap().clear();
}

#[tauri::command]
fn get_all_exceptions(state: State<AppState>) -> Vec<Value> {
    state.store.lock().unwrap().exceptions()
}

#[tauri::command]
fn get_exception(state: State<AppState>, id: u64) -> Option<Value> {
    state.store.lock().unwrap().exception(id)
}

#[tauri::command]
fn remove_exception(state: State<AppState>, id: u64) {
    state.store.lock().unwrap().remove_exception(id);
}

#[tauri::command]
fn clear_exceptions(state: State<AppState>) {
    state.store.lock().unwrap().clear_exceptions();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .setup(|app| {
            let settings = settings::load(app.handle());
            let theme = settings.theme;
            *app.state::<AppState>().settings.lock().unwrap() = settings;
            apply_theme(app.handle(), theme);

            server::start(app.handle());
            Ok(())
        })
        // the settings window should not keep the app alive on its own
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event, WindowEvent::Destroyed) {
                window.app_handle().exit(0);
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_server_status,
            get_settings,
            save_settings,
            open_settings,
            open_payloads,
            open_flamegraph,
            get_all_requests,
            get_request,
            get_request_context,
            get_request_messages,
            get_request_queries,
            get_request_cachegrind,
            remove_request,
            clear_requests,
            get_all_exceptions,
            get_exception,
            remove_exception,
            clear_exceptions
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
