//! Mapping for TAPD's internal (web session) API.

pub mod api;
pub mod changes;
pub mod model;

pub use api::{bug_detail_url, bug_web_url, BugQuery};
pub use changes::{changes_list_url, parse_changes_html, CHANGES_PER_PAGE};
pub use model::{
    Attachment, BugDetail, BugListPage, BugSummary, ChangeEntry, ChangeField, ChangeHistory,
    Comment, MediaKind, MediaRef, Workspace, WorkspaceMember,
};
