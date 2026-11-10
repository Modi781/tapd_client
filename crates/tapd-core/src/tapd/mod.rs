//! Mapping for TAPD's internal (web session) API.

pub mod api;
pub mod model;

pub use api::{bug_detail_url, bug_web_url, BugQuery};
pub use model::{
    Attachment, BugDetail, BugListPage, BugSummary, Comment, Workspace,
};
