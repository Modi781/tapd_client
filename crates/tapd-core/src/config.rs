use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Persistent user configuration. Secrets are never stored here.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppConfig {
    /// Whether the embedded TAPD session has been verified.
    pub logged_in: bool,
    /// TAPD nickname of the signed-in user, when known.
    pub me: Option<String>,
    /// Last selected workspace, restored on launch.
    pub last_workspace_id: Option<String>,
    /// Last known TAPD page URL (used for diagnostics only).
    pub last_session_url: Option<String>,
    /// Request capture used during the API discovery phase.
    pub capture_enabled: bool,
    /// Whether the user has completed first-run onboarding.
    pub onboarded: bool,
    /// Polling interval for bug sync, in seconds.
    pub poll_interval_secs: u64,
    /// Name shown in the UI; purely cosmetic.
    pub device_name: Option<String>,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            logged_in: false,
            me: None,
            last_workspace_id: None,
            last_session_url: None,
            capture_enabled: true,
            onboarded: false,
            poll_interval_secs: 60,
            device_name: None,
        }
    }
}

#[derive(Clone, Debug)]
pub struct ConfigStore {
    path: PathBuf,
}

impl ConfigStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn load(&self) -> AppConfig {
        match std::fs::read_to_string(&self.path) {
            Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
            Err(_) => AppConfig::default(),
        }
    }

    pub fn save(&self, config: &AppConfig) -> io::Result<()> {
        let raw = serde_json::to_vec_pretty(config)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        let tmp = self.path.with_extension("json.tmp");
        {
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create(true).truncate(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&tmp)?;
            file.write_all(&raw)?;
            file.sync_all()?;
        }
        std::fs::rename(&tmp, &self.path)?;
        Ok(())
    }
}
