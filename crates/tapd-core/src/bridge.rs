use serde::{Deserialize, Serialize};

/// One captured same-origin request/response from the hidden TAPD webview.
///
/// This is the raw material for mapping TAPD's internal web API. Bodies are
/// truncated in the injected script so the snapshot stays bounded.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapturedRequest {
    pub id: u64,
    pub ts: String,
    pub method: String,
    pub url: String,
    pub status: Option<u16>,
    pub content_type: Option<String>,
    pub request_body: Option<String>,
    pub response_body: Option<String>,
    pub size: Option<u64>,
    pub duration_ms: Option<u64>,
    pub error: Option<String>,
    pub truncated: bool,
}

/// A generic JSON response returned from the webview bridge.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeHttpResult {
    pub ok: bool,
    pub status: u16,
    pub url: String,
    pub content_type: Option<String>,
    pub body: String,
    pub error: Option<String>,
}

/// Shape returned by the injected `ping()` probe.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgePing {
    pub url: String,
    pub title: String,
    pub ready_state: String,
    pub has_invoke: bool,
    pub has_capture: bool,
    pub capture_count: usize,
    pub cookie_length: usize,
    pub user_agent: String,
}
