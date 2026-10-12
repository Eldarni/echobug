use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const HOSTS: [&str; 2] = ["127.0.0.1", "0.0.0.0"];

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    #[default]
    System,
    Light,
    Dark,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub port: u16,
    pub host: String,
    pub theme: Theme,
}

impl Default for Settings {
    fn default() -> Self {
        Self { port: 3000, host: "127.0.0.1".into(), theme: Theme::System }
    }
}

impl Settings {
    pub fn validate(&self) -> Result<(), String> {
        if self.port == 0 {
            return Err("port must be between 1 and 65535".into());
        }

        if !HOSTS.contains(&self.host.as_str()) {
            return Err(format!("host must be one of {}", HOSTS.join(", ")));
        }

        Ok(())
    }
}

fn path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|err| err.to_string())?;
    Ok(dir.join("settings.json"))
}

// a missing or unusable settings file is not worth failing over, we just start with the defaults
pub fn load(app: &AppHandle) -> Settings {
    path(app)
        .ok()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|contents| serde_json::from_str::<Settings>(&contents).ok())
        .filter(|settings| settings.validate().is_ok())
        .unwrap_or_default()
}

pub fn save(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let path = path(app)?;

    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|err| err.to_string())?;
    }

    let contents = serde_json::to_string_pretty(settings).map_err(|err| err.to_string())?;
    fs::write(path, contents).map_err(|err| err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_valid() {
        let settings = Settings::default();
        assert_eq!(settings.port, 3000);
        assert_eq!(settings.host, "127.0.0.1");
        assert!(settings.validate().is_ok());
    }

    #[test]
    fn missing_fields_fall_back_to_defaults() {
        let settings: Settings = serde_json::from_str(r#"{ "port": 3001 }"#).unwrap();
        assert_eq!(settings, Settings { port: 3001, ..Default::default() });
    }

    #[test]
    fn rejects_unusable_values() {
        assert!(Settings { port: 0, ..Default::default() }.validate().is_err());
        assert!(Settings { host: "example.com".into(), ..Default::default() }.validate().is_err());
        assert!(Settings { port: 8080, host: "0.0.0.0".into(), ..Default::default() }.validate().is_ok());
        assert!(serde_json::from_str::<Settings>(r#"{ "port": 70000 }"#).is_err());
    }

    #[test]
    fn theme_defaults_to_system() {
        assert_eq!(Settings::default().theme, Theme::System);

        let settings: Settings = serde_json::from_str(r#"{ "theme": "dark" }"#).unwrap();
        assert_eq!(settings.theme, Theme::Dark);
        assert_eq!(serde_json::to_value(Theme::Light).unwrap(), "light");

        assert!(serde_json::from_str::<Settings>(r#"{ "theme": "purple" }"#).is_err());
    }
}
