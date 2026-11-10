//! Local audit trail for MCP tool calls.
//!
//! The sidecar forwards every call to `/mcp/call`; the app records the tool,
//! client, policy decision and outcome here. Bodies/comment text are never
//! stored, only small scalar summaries.

use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde::{Deserialize, Serialize};
use serde_json::Value;

const MAX_ENTRIES: usize = 500;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpAuditEntry {
    pub id: String,
    pub ts: String,
    pub tool: String,
    pub client: String,
    /// `allowed` | `denied` | `error`
    pub decision: String,
    pub ok: bool,
    pub duration_ms: u64,
    pub workspace_id: Option<String>,
    pub bug_id: Option<String>,
    pub error: Option<String>,
    /// Non-sensitive call shape (ids, status, limits, comment length).
    pub summary: Value,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct AuditFile {
    #[serde(default)]
    entries: Vec<McpAuditEntry>,
}

pub struct McpAudit {
    path: PathBuf,
    entries: Mutex<Vec<McpAuditEntry>>,
}

impl McpAudit {
    pub fn load(path: impl Into<PathBuf>) -> Self {
        let path = path.into();
        let entries = fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<AuditFile>(&raw).ok())
            .map(|file| file.entries)
            .unwrap_or_default();

        Self {
            path,
            entries: Mutex::new(entries),
        }
    }

    /// Appends an entry and persists the bounded log. Persistence failures are
    /// logged by the caller; auditing must never break a tool call.
    pub fn record(&self, entry: McpAuditEntry) -> io::Result<()> {
        {
            let mut entries = self.entries.lock().expect("mcp audit lock");
            entries.push(entry);
            let excess = entries.len().saturating_sub(MAX_ENTRIES);
            if excess > 0 {
                entries.drain(0..excess);
            }
        }
        self.persist()
    }

    pub fn list(&self, limit: usize) -> Vec<McpAuditEntry> {
        let entries = self.entries.lock().expect("mcp audit lock");
        entries
            .iter()
            .rev()
            .take(limit.max(1).min(MAX_ENTRIES))
            .cloned()
            .collect()
    }

    pub fn clear(&self) -> io::Result<()> {
        self.entries.lock().expect("mcp audit lock").clear();
        if self.path.exists() {
            fs::remove_file(&self.path)?;
        }
        Ok(())
    }

    /// Writes the full audit log as pretty JSON and returns the file path.
    pub fn export(&self, path: &Path) -> io::Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let entries = self.entries.lock().expect("mcp audit lock").clone();
        let raw = serde_json::to_vec_pretty(&AuditFile { entries })
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        fs::write(path, raw)
    }

    fn persist(&self) -> io::Result<()> {
        let entries = self.entries.lock().expect("mcp audit lock").clone();
        let raw = serde_json::to_vec_pretty(&AuditFile { entries })
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let tmp = self.path.with_extension("json.tmp");
        {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .open(&tmp)?;
            file.write_all(&raw)?;
            file.sync_all()?;
        }
        fs::rename(&tmp, &self.path)
    }
}
