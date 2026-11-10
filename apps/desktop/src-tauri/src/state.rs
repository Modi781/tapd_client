use std::sync::{Arc, Mutex};

use tapd_core::{
    config::{AppConfig, ConfigStore},
    paths::AppPaths,
    runtime::RuntimeInfo,
};

use crate::cache::Cache;
use crate::mcp_audit::McpAudit;

/// Shared state for Tauri commands, the local HTTP server and the session watcher.
pub struct AppState {
    pub paths: AppPaths,
    pub config_store: ConfigStore,
    pub config: Mutex<AppConfig>,
    pub runtime: Mutex<Option<RuntimeInfo>>,
    /// Offline snapshot cache (projects/bugs). Disabled if SQLite failed to open.
    pub cache: Arc<Cache>,
    /// Bounded MCP call audit log.
    pub mcp_audit: McpAudit,
}

impl AppState {
    pub fn new(paths: AppPaths, config_store: ConfigStore, config: AppConfig) -> Self {
        let cache = Arc::new(Cache::open(paths.data_dir.join("cache.sqlite3")));
        let mcp_audit = McpAudit::load(paths.data_dir.join("mcp-audit.json"));
        Self {
            paths,
            config_store,
            config: Mutex::new(config),
            runtime: Mutex::new(None),
            cache,
            mcp_audit,
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
