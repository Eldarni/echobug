mod server;
mod settings;

use serde_json::Value;
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use server::AppState;
use settings::Settings;

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

    *state.settings.lock().unwrap() = settings;
    server::restart(&app);

    Ok(server::status(&app))
}

// this has to be async, creating a window from a sync command deadlocks on windows
#[tauri::command]
async fn open_settings(app: AppHandle) -> Result<(), String> {
    open_window(&app, "settings", "settings.html", "echobug settings", (460.0, 300.0), false)
}

// shows payloads exactly as they arrive, for as long as the window is open
#[tauri::command]
async fn open_payloads(app: AppHandle) -> Result<(), String> {
    open_window(&app, server::PAYLOADS_WINDOW, "payloads.html", "echobug payloads", (900.0, 700.0), true)
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
    store.get(&request_id).map(|request| request.context().clone())
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .setup(|app| {
            let settings = settings::load(app.handle());
            *app.state::<AppState>().settings.lock().unwrap() = settings;

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
            get_all_requests,
            get_request,
            get_request_context,
            get_request_messages,
            get_request_queries,
            remove_request,
            clear_requests
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
