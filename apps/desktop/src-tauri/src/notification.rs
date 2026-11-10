//! M6 — new-bug detection, notification window and accept action.
//!
//! Owned by the M6 implementation. Exposed through `feature_command` names
//! starting with `notification_`.

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
    Err(format!("notification feature is not implemented yet: {name}"))
}
