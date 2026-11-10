//! M7 — opencode agent queue, PTY session and console window.
//!
//! Owned by the M7 implementation. Exposed through `feature_command` names
//! starting with `agent_`.

use serde_json::Value;
use tauri::AppHandle;

use crate::state::SharedState;

pub fn init(app: &AppHandle, state: SharedState) {
    let _ = (app, state);
}

pub async fn command(
    _app: &AppHandle,
    _state: &SharedState,
    name: &str,
    _payload: Value,
) -> Result<Value, String> {
    Err(format!("agent feature is not implemented yet: {name}"))
}
