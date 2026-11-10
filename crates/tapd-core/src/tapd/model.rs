use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub pretty_name: String,
    pub category: String,
    pub status: String,
    pub logo_color: Option<String>,
    pub last_visited_time: Option<String>,
    pub jump_url: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BugSummary {
    pub id: String,
    pub short_id: String,
    pub workspace_id: String,
    pub title: String,
    pub status: String,
    pub status_label: String,
    pub priority: String,
    pub priority_label: String,
    pub severity: String,
    pub severity_label: String,
    pub owner: String,
    pub creator: String,
    pub created: String,
    pub modified: String,
    pub due: String,
    pub iteration_id: String,
    pub iteration_name: String,
    pub module: String,
    pub version_report: String,
    pub story_id: String,
    pub story_name: String,
    pub bug_url: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BugListPage {
    pub page: u32,
    pub perpage: u32,
    pub total: u32,
    pub status_map: BTreeMap<String, String>,
    pub bugs: Vec<BugSummary>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    pub id: String,
    pub author: String,
    pub created: String,
    pub description_html: String,
    pub plain_text: String,
    pub is_deleted: bool,
    pub replies: Vec<Comment>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: String,
    pub filename: String,
    pub content_type: String,
    pub size: u64,
    pub filetype: String,
    pub owner: String,
    pub created: String,
    pub entry_id: String,
    pub video_poster: String,
    pub video_origin_file: String,
    pub download_url: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BugDetail {
    #[serde(flatten)]
    pub summary: BugSummary,
    pub description_html: String,
    pub description_text: String,
    pub platform: String,
    pub os: String,
    pub testtype: String,
    pub testphase: String,
    pub source: String,
    pub resolution: String,
    pub resolved: String,
    pub closed: String,
    pub reopen_time: String,
    pub fixer: String,
    pub de: String,
    pub te: String,
    pub participants: String,
    pub cc: String,
    pub follower: String,
    pub release_name: String,
    pub workspace_name: String,
    pub custom_fields: BTreeMap<String, String>,
    pub comments: Vec<Comment>,
    pub attachments: Vec<Attachment>,
}
