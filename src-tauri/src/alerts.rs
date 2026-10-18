// bars along the bottom of the main window for anything the user should know about - src/alerts.js shows them. Nothing
// is kept here, so an alert sent while the window is loading is lost
#![allow(dead_code)] // nothing raises an alert yet

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Runtime};

const MAIN_WINDOW: &str = "main";

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Info,
    Warn,
    Error,
}

// a button that invokes a command - dismiss hides the alert once it has been clicked
#[derive(Clone, Debug, Serialize)]
pub struct Action {
    pub label: String,
    pub command: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<Value>,
    pub dismiss: bool,
}

// showing an alert with the id of one that is already showing replaces it - title is shown on hover
#[derive(Clone, Debug, Serialize)]
pub struct Alert {
    pub id: String,
    pub level: Level,
    pub text: String,
    pub title: Option<String>,
    pub actions: Vec<Action>,
}

pub fn show<R: Runtime>(app: &AppHandle<R>, alert: Alert) {
    emit(app, "alert-show", json!(alert));
}

pub fn hide<R: Runtime>(app: &AppHandle<R>, id: &str) {
    emit(app, "alert-hide", json!({ "id": id }));
}

fn emit<R: Runtime>(app: &AppHandle<R>, event: &str, payload: Value) {
    if let Err(err) = app.emit_to(MAIN_WINDOW, event, payload) {
        eprintln!("[echobug] failed to notify the main window: {err}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // the shape src/alerts.js expects
    #[test]
    fn serializes_for_the_webview() {
        let alert = Alert {
            id: "disk".into(),
            level: Level::Warn,
            text: "The disk is nearly full".into(),
            title: None,
            actions: vec![
                Action { label: "Open".into(), command: "open_folder".into(), args: Some(json!({ "path": "/" })), dismiss: true },
                Action { label: "Later".into(), command: "snooze".into(), args: None, dismiss: false },
            ],
        };

        assert_eq!(
            json!(alert),
            json!({
                "id": "disk",
                "level": "warn",
                "text": "The disk is nearly full",
                "title": null,
                "actions": [
                    { "label": "Open", "command": "open_folder", "args": { "path": "/" }, "dismiss": true },
                    { "label": "Later", "command": "snooze", "dismiss": false },
                ],
            })
        );
        assert_eq!(json!(Level::Info), "info");
        assert_eq!(json!(Level::Error), "error");
    }
}
