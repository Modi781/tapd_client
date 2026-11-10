use std::sync::{Arc, Mutex};

use tapd_core::{
    config::{AppConfig, ConfigStore},
    paths::AppPaths,
    runtime::RuntimeInfo,
};
/// Shared state for Tauri commands, the local HTTP server and the session watcher.
pub struct AppState {
    pub paths: AppPaths,
    pub config_store: ConfigStore,
    pub config: Mutex<AppConfig>,
    pub runtime: Mutex<Option<RuntimeInfo>>,
}

impl AppState {
    pub fn new(paths: AppPaths, config_store: ConfigStore, config: AppConfig) -> Self {
        Self {
            paths,
            config_store,
            config: Mutex::new(config),
            runtime: Mutex::new(None),
        }
    }

    pub fn config_snapshot(&self) -> AppConfig {
        self.config.lock().expect("config lock").clone()
    }

    pub fn save_config(&self, config: &AppConfig) -> std::io::Result<()> {
        self.config_store.save(config)
    }

    pub fn runtime_info(&self) -> Option<RuntimeInfo> {
        self.runtime.lock().expect("runtime lock").clone()
    }
}

pub type SharedState = Arc<AppState>;
