use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    time::Duration,
};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tapd_core::{
    export::{
        collect_media, download_url_for, render_markdown, slugify, MediaAsset, MediaKind, MediaRef,
    },
    tapd::{
        api::{bug_detail_body, bug_detail_url, parse_bug_detail},
        BugDetail,
    },
};

use crate::{
    commands::session_request_json,
    session,
    state::SharedState,
};

const MAX_FILE_BYTES: u64 = 200 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 300 * 1024 * 1024;
const USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
const REFERER: &str = "https://www.tapd.cn/";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub dir: String,
    pub markdown_path: String,
    pub asset_count: usize,
    pub downloaded_bytes: u64,
    pub warnings: Vec<String>,
}

#[tauri::command]
pub async fn export_bug_md(
    app: AppHandle,
    state: State<'_, SharedState>,
    workspace_id: String,
    bug_id: String,
    workspace_name: Option<String>,
) -> Result<ExportResult, String> {
    run_export(&app, &state.paths, &workspace_id, &bug_id, workspace_name).await
}

pub async fn run_export(
    app: &AppHandle,
    paths: &tapd_core::paths::AppPaths,
    workspace_id: &str,
    bug_id: &str,
    workspace_name: Option<String>,
) -> Result<ExportResult, String> {
    let detail = fetch_detail(app, workspace_id, bug_id).await?;
    let label = workspace_name
        .filter(|name| !name.trim().is_empty())
        .or_else(|| {
            let name = detail.workspace_name.trim().to_string();
            (!name.is_empty()).then_some(name)
        })
        .unwrap_or_else(|| workspace_id.to_string());

    let window = app
        .get_webview_window(session::SESSION_LABEL)
        .ok_or_else(|| "会话窗口尚未创建".to_string())?;
    let cookie = session::cookie_header(&window)?;

    let workspace_dir = paths
        .exports_dir
        .join(format!("{}-{}", slugify(&label), workspace_id));
    let bug_dir = workspace_dir.join(format!(
        "{}-{}",
        detail.summary.id,
        slugify(&detail.summary.title)
    ));
    let assets_dir = bug_dir.join("assets");
    std::fs::create_dir_all(&assets_dir).map_err(|error| error.to_string())?;

    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|error| error.to_string())?;

    let media = collect_media(&detail);
    let mut assets: Vec<MediaAsset> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    let mut used_names: HashSet<String> = HashSet::new();
    let mut total_bytes: u64 = 0;
    let mut media_index = 0usize;

    for item in media {
        if total_bytes >= MAX_TOTAL_BYTES {
            warnings.push("已达到导出总大小上限，剩余资源未下载".to_string());
            break;
        }

        media_index += 1;
        match download_one(
            &client,
            &cookie,
            &item,
            media_index,
            &assets_dir,
            &mut used_names,
        )
        .await
        {
            Ok(asset) => {
                total_bytes += asset.size;
                assets.push(asset);
            }
            Err(error) => warnings.push(format!("{}：{}", item.filename_hint, error)),
        }
    }

    let markdown = render_markdown(&detail, &assets, &label);
    let markdown_path = bug_dir.join("bug.md");
    std::fs::write(&markdown_path, markdown).map_err(|error| error.to_string())?;

    let json_path = bug_dir.join("bug.json");
    let json = serde_json::to_vec_pretty(&detail).map_err(|error| error.to_string())?;
    std::fs::write(&json_path, json).map_err(|error| error.to_string())?;

    tracing::info!(
        bug_id,
        assets = assets.len(),
        bytes = total_bytes,
        path = %bug_dir.display(),
        "bug exported"
    );

    Ok(ExportResult {
        dir: bug_dir.to_string_lossy().to_string(),
        markdown_path: markdown_path.to_string_lossy().to_string(),
        asset_count: assets.len(),
        downloaded_bytes: total_bytes,
        warnings,
    })
}

async fn fetch_detail(
    app: &AppHandle,
    workspace_id: &str,
    bug_id: &str,
) -> Result<BugDetail, String> {
    let root = session_request_json(
        app,
        "POST",
        &bug_detail_url(),
        Some(bug_detail_body(workspace_id, bug_id)),
        Duration::from_secs(45),
    )
    .await?;

    parse_bug_detail(&root)
}

async fn download_one(
    client: &reqwest::Client,
    cookie: &str,
    item: &MediaRef,
    index: usize,
    assets_dir: &Path,
    used_names: &mut HashSet<String>,
) -> Result<MediaAsset, String> {
    let download_url = download_url_for(&item.url);
    let response = client
        .get(&download_url)
        .header(reqwest::header::COOKIE, cookie)
        .header(reqwest::header::REFERER, REFERER)
        .header(reqwest::header::ACCEPT, "*/*")
        .send()
        .await
        .map_err(|error| error.to_string())?;

    let status = response.status();
    if !status.is_success() {
        return Err(format!("HTTP {status}"));
    }

    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();

    let length = response.content_length().unwrap_or(0);
    if length > MAX_FILE_BYTES {
        return Err("文件超过 200MB，已跳过".to_string());
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|error| error.to_string())?;

    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err("文件超过 200MB，已跳过".to_string());
    }

    // TAPD returns a short placeholder instead of the file when the URL or
    // permissions are wrong.
    let body_head = String::from_utf8_lossy(&bytes[..bytes.len().min(64)]).to_lowercase();
    if content_type.starts_with("text/html") && body_head.contains("error") {
        return Err(format!("下载被拒绝（{content_type}）"));
    }

    let filename = unique_filename(
        &item.filename_hint,
        &content_type,
        item.kind,
        index,
        used_names,
    );
    let path = assets_dir.join(&filename);
    std::fs::write(&path, &bytes).map_err(|error| error.to_string())?;

    Ok(MediaAsset {
        url: item.url.clone(),
        relative_path: format!("assets/{filename}"),
        filename,
        kind: item.kind,
        size: bytes.len() as u64,
        content_type,
    })
}

fn unique_filename(
    hint: &str,
    content_type: &str,
    kind: MediaKind,
    index: usize,
    used: &mut HashSet<String>,
) -> String {
    let base = sanitize_filename(hint);
    let base = if base.is_empty() || base == "asset" || base == "poster" {
        format!(
            "media-{index}-{}",
            if base.is_empty() { "asset" } else { base.as_str() }
        )
    } else {
        base
    };
    let base = ensure_extension(&base, content_type, kind);

    let mut candidate = base.clone();
    let mut counter = 2usize;
    while used.contains(&candidate) {
        let path = PathBuf::from(&base);
        let stem = path.file_stem().and_then(|stem| stem.to_str()).unwrap_or("asset");
        let extension = path.extension().and_then(|extension| extension.to_str()).unwrap_or("");
        candidate = if extension.is_empty() {
            format!("{stem}-{counter}")
        } else {
            format!("{stem}-{counter}.{extension}")
        };
        counter += 1;
    }

    used.insert(candidate.clone());
    candidate
}

fn sanitize_filename(value: &str) -> String {
    let mut result = String::new();
    for character in value.chars() {
        if character.is_alphanumeric() || matches!(character, '.' | '-' | '_') {
            result.push(character);
        } else if character == ' ' {
            result.push('_');
        }
        if result.len() >= 90 {
            break;
        }
    }

    result.trim_matches(['.', '-', '_']).to_string()
}

fn ensure_extension(filename: &str, content_type: &str, kind: MediaKind) -> String {
    let path = Path::new(filename);
    let has_extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| !extension.is_empty());
    if has_extension {
        return filename.to_string();
    }

    let extension = match content_type.split(';').next().unwrap_or("") {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/bmp" => "bmp",
        "image/svg+xml" => "svg",
        "video/mp4" => "mp4",
        "video/quicktime" => "mov",
        "video/webm" => "webm",
        "application/pdf" => "pdf",
        "application/zip" => "zip",
        "text/plain" => "txt",
        _ => match kind {
            MediaKind::Image => "png",
            MediaKind::Video => "mp4",
            MediaKind::File => "",
        },
    };

    if extension.is_empty() {
        filename.to_string()
    } else {
        format!("{filename}.{extension}")
    }
}
