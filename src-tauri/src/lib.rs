mod server;

use serde_json::{json, Value};
use tauri::State;

use server::AppState;

#[tauri::command]
fn get_server_status(state: State<AppState>) -> Value {
    json!({ "port": server::PORT, "error": *state.server_error.lock().unwrap() })
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .setup(|app| {
            server::start(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_server_status,
            get_all_requests,
            get_request,
            get_request_context,
            get_request_messages,
            get_request_queries,
            remove_request
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
