use std::io::{self, Write};
use std::path::Path;

use serde::{Deserialize, Serialize};

/// Runtime handshake between the desktop app and the MCP sidecar.
///
/// The file is created on every app launch with a fresh token and port, and
/// removed on graceful shutdown. The sidecar treats a stale file as "app not
/// running" after a failed health check.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInfo {
    pub app: String,
    pub version: String,
    pub pid: u32,
    pub port: u16,
    pub token: String,
    pub started_at: String,
}

impl RuntimeInfo {
    pub fn read(path: &Path) -> io::Result<Self> {
        let raw = std::fs::read_to_string(path)?;
        serde_json::from_str(&raw)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
    }

    /// Writes with owner-only permissions so the local bearer token stays private.
    pub fn write(&self, path: &Path) -> io::Result<()> {
        let raw = serde_json::to_vec_pretty(self)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        let tmp = path.with_extension("json.tmp");
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
        std::fs::rename(&tmp, path)?;
        Ok(())
    }

    pub fn clear(path: &Path) {
        let _ = std::fs::remove_file(path);
    }

    /// Best-effort liveness check for a pid on unix systems.
    pub fn pid_alive(&self) -> bool {
        #[cfg(unix)]
        {
            std::process::Command::new("kill")
                .args(["-0", &self.pid.to_string()])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .map(|status| status.success())
                .unwrap_or(false)
        }
        #[cfg(not(unix))]
        {
            true
        }
    }
}
