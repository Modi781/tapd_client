//! One-click MCP injection for external agents (currently opencode).
//!
//! [`ensure_opencode_mcp`] merges the bundled `tapd-mcp` sidecar into the
//! opencode global config. It is idempotent, never touches a file it cannot
//! parse, and backs the file up before writing. Frontend access goes through
//! the `mcp_import_opencode` feature command.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Map, Value};

use crate::state::SharedState;

const CONFIG_SCHEMA: &str = "https://opencode.ai/config.json";
const CONFIG_JSON: &str = "opencode.json";
const CONFIG_JSONC: &str = "opencode.jsonc";
const DEBUG_PATHS_TIMEOUT: Duration = Duration::from_secs(3);

/// Location of the opencode global config, if it can be discovered.
///
/// Asks the CLI first (`opencode debug paths`), because XDG overrides and
/// custom installs are only visible to opencode itself. Falls back to the
/// conventional XDG/home locations.
pub fn opencode_config_path() -> Option<PathBuf> {
    config_path_from_cli().or_else(fallback_config_path)
}

/// Ensures the tapd MCP server is present in the opencode global config.
///
/// Returns `{ path, backupPath, changed, imported }`, matching the frontend
/// `McpImportResult` contract.
pub fn ensure_opencode_mcp(command_path: &str) -> Result<Value, String> {
    if command_path.trim().is_empty() {
        return Err("sidecar 路径为空，无法写入 opencode 配置".to_string());
    }

    let path = opencode_config_path().ok_or_else(|| {
        "无法定位 opencode 配置目录（未设置 XDG_CONFIG_HOME 或 HOME）".to_string()
    })?;
    let outcome = ensure_mcp_in_file(&path, command_path)?;

    Ok(json!({
        "path": path.to_string_lossy(),
        "backupPath": outcome.backup_path.map(|path| path.to_string_lossy().to_string()),
        "changed": outcome.changed,
        "imported": true,
    }))
}

pub async fn command(
    _state: &SharedState,
    name: &str,
    _payload: Value,
) -> Result<Value, String> {
    match name {
        "mcp_import_opencode" => {
            let command_path = crate::commands::sidecar_command_path();
            tokio::task::spawn_blocking(move || ensure_opencode_mcp(&command_path))
                .await
                .map_err(|error| format!("导入任务中断：{error}"))?
        }
        other => Err(format!("unknown mcp command: {other}")),
    }
}

/// Runs `opencode debug paths` and parses the config entry out of its output.
fn config_path_from_cli() -> Option<PathBuf> {
    let stdout = run_with_timeout("opencode", &["debug", "paths"], DEBUG_PATHS_TIMEOUT)?;
    parse_debug_paths(&stdout)
}

/// Runs a command, killing it after `timeout` and returning its stdout.
fn run_with_timeout(binary: &str, args: &[&str], timeout: Duration) -> Option<String> {
    let mut child = Command::new(binary)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if started.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }

    let output = child.wait_with_output().ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Parses the label/path table printed by `opencode debug paths`.
///
/// Example (opencode v2):
/// ```text
/// home       /Users/me
/// config     /Users/me/.config/opencode
/// data       /Users/me/.local/share/opencode
/// ```
/// Some builds print a full config file path instead of the directory; both
/// `opencode.json` and `opencode.jsonc` are accepted.
fn parse_debug_paths(output: &str) -> Option<PathBuf> {
    for line in output.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Some((label, rest)) = line.split_once(char::is_whitespace) else {
            continue;
        };
        if !is_config_label(label) {
            continue;
        }
        let value = rest
            .split_whitespace()
            .find(|token| token.starts_with('/') || token.starts_with('~'));
        if let Some(value) = value {
            return Some(resolve_config_path(&expand_home(value)));
        }
    }

    // Fallback: a bare path to a config file (no label column).
    output
        .split_whitespace()
        .find(|token| is_config_file_name(Path::new(token)) && token.contains('/'))
        .map(|token| expand_home(token))
}

fn is_config_label(label: &str) -> bool {
    let normalized: String = label
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase();
    normalized.starts_with("config")
}

fn expand_home(value: &str) -> PathBuf {
    if let Some(rest) = value.strip_prefix("~/") {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join(rest);
        }
    }
    PathBuf::from(value)
}

/// The CLI may print either the config directory or the config file itself.
fn resolve_config_path(path: &Path) -> PathBuf {
    if is_config_file_name(path) || has_config_extension(path) {
        path.to_path_buf()
    } else {
        config_file_for_dir(path)
    }
}

fn is_config_file_name(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            name.eq_ignore_ascii_case(CONFIG_JSON) || name.eq_ignore_ascii_case(CONFIG_JSONC)
        })
}

fn has_config_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("json") || extension.eq_ignore_ascii_case("jsonc")
        })
}

/// opencode supports both files; prefer `opencode.jsonc` when it exists.
fn config_file_for_dir(dir: &Path) -> PathBuf {
    let jsonc = dir.join(CONFIG_JSONC);
    if jsonc.is_file() {
        jsonc
    } else {
        dir.join(CONFIG_JSON)
    }
}

fn fallback_config_path() -> Option<PathBuf> {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))?;
    Some(config_file_for_dir(&base.join("opencode")))
}

#[derive(Debug)]
struct MergeOutcome {
    changed: bool,
    backup_path: Option<PathBuf>,
}

fn tapd_entry(command_path: &str) -> Value {
    json!({ "type": "local", "command": [command_path] })
}

/// Merges `mcp.servers.tapd` into the JSON file at `path`.
///
/// - missing file: starts from `{ "$schema": ... }` (no backup to make)
/// - existing but unparseable file: errors without touching it
/// - unchanged entry: returns early with `changed: false` and no backup
/// - any change: copies the old file to `<file>.bak-<unix-ts>`, then writes
///   atomically via a sibling temp file + rename
fn ensure_mcp_in_file(path: &Path, command_path: &str) -> Result<MergeOutcome, String> {
    let existing = match std::fs::read_to_string(path) {
        Ok(raw) => Some(raw),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("读取 opencode 配置失败：{error}")),
    };

    let desired = tapd_entry(command_path);
    let (mut config, existed) = match existing {
        Some(raw) => {
            let value: Value = serde_json::from_str(&raw).map_err(|error| {
                format!(
                    "无法解析 {}（可能是带注释的 JSONC）：{error}。为避免破坏已有内容，未做任何修改。",
                    path.display()
                )
            })?;
            if !value.is_object() {
                return Err(format!(
                    "{} 的根节点不是 JSON 对象，未做任何修改",
                    path.display()
                ));
            }
            (value, true)
        }
        None => (json!({ "$schema": CONFIG_SCHEMA }), false),
    };

    if config.pointer("/mcp/servers/tapd") == Some(&desired) {
        return Ok(MergeOutcome {
            changed: false,
            backup_path: None,
        });
    }

    let root = config
        .as_object_mut()
        .ok_or_else(|| format!("{} 的根节点不是 JSON 对象", path.display()))?;
    let mcp = root
        .entry("mcp")
        .or_insert_with(|| Value::Object(Map::new()));
    let mcp = mcp
        .as_object_mut()
        .ok_or_else(|| "opencode 配置中的 mcp 字段不是对象，未做任何修改".to_string())?;
    let servers = mcp
        .entry("servers")
        .or_insert_with(|| Value::Object(Map::new()));
    let servers = servers
        .as_object_mut()
        .ok_or_else(|| "opencode 配置中的 mcp.servers 不是对象，未做任何修改".to_string())?;
    servers.insert("tapd".to_string(), desired);

    let mut rendered =
        serde_json::to_string_pretty(&config).map_err(|error| error.to_string())?;
    rendered.push('\n');

    let backup_path = if existed {
        let backup = backup_path_for(path);
        std::fs::copy(path, &backup)
            .map_err(|error| format!("备份 opencode 配置失败：{error}"))?;
        Some(backup)
    } else {
        None
    };

    write_atomic(path, rendered.as_bytes())?;

    Ok(MergeOutcome {
        changed: true,
        backup_path,
    })
}

/// Whether the given config file already points at this sidecar.
pub(crate) fn is_imported_in(path: &Path, command_path: &str) -> bool {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return false;
    };
    let Ok(config) = serde_json::from_str::<Value>(&raw) else {
        return false;
    };
    config
        .pointer("/mcp/servers/tapd/command")
        .is_some_and(|value| command_matches(value, command_path))
}

fn command_matches(value: &Value, command_path: &str) -> bool {
    match value {
        Value::Array(items) => items.iter().any(|item| item.as_str() == Some(command_path)),
        Value::String(item) => item == command_path,
        _ => false,
    }
}

fn backup_path_for(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(CONFIG_JSON);
    path.with_file_name(format!("{name}.bak-{}", unix_timestamp()))
}

fn unix_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn write_atomic(path: &Path, contents: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("创建 opencode 配置目录失败：{error}"))?;

    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(CONFIG_JSON);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let temp = parent.join(format!(".{name}.tmp-{}-{nanos}", std::process::id()));

    if let Err(error) = std::fs::write(&temp, contents) {
        let _ = std::fs::remove_file(&temp);
        return Err(format!("写入 opencode 配置失败：{error}"));
    }

    // Replacing a file through rename would otherwise reset its mode.
    if let Ok(metadata) = std::fs::metadata(path) {
        let _ = std::fs::set_permissions(&temp, metadata.permissions());
    }

    if let Err(error) = std::fs::rename(&temp, path) {
        let _ = std::fs::remove_file(&temp);
        return Err(format!("保存 opencode 配置失败：{error}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "tapd-mcp-import-{name}-{}-{stamp}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn cleanup(dir: &Path) {
        let _ = std::fs::remove_dir_all(dir);
    }

    fn backup_files(dir: &Path) -> Vec<PathBuf> {
        std::fs::read_dir(dir)
            .expect("read temp dir")
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.to_string_lossy().contains(".bak-"))
            .collect()
    }

    #[test]
    fn merge_preserves_other_settings() {
        let dir = temp_dir("merge");
        let path = dir.join(CONFIG_JSON);
        let original = json!({
            "$schema": CONFIG_SCHEMA,
            "model": "anthropic/claude",
            "mcp": { "servers": { "other": { "type": "local", "command": ["other"] } } }
        });
        std::fs::write(&path, serde_json::to_string_pretty(&original).unwrap()).unwrap();

        let outcome = ensure_mcp_in_file(&path, "/Applications/TAPD/tapd-mcp").unwrap();
        assert!(outcome.changed);
        let backup = outcome.backup_path.expect("backup created");
        assert!(backup.is_file());
        assert!(backup.to_string_lossy().contains(".bak-"));

        let written: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(written.get("model"), Some(&json!("anthropic/claude")));
        assert_eq!(
            written.pointer("/mcp/servers/other/command"),
            Some(&json!(["other"]))
        );
        assert_eq!(
            written.pointer("/mcp/servers/tapd"),
            Some(&json!({ "type": "local", "command": ["/Applications/TAPD/tapd-mcp"] }))
        );
        assert!(is_imported_in(&path, "/Applications/TAPD/tapd-mcp"));
        assert!(!is_imported_in(&path, "/Applications/TAPD/other"));

        cleanup(&dir);
    }

    #[test]
    fn missing_file_creates_parent_dirs_and_defaults() {
        let dir = temp_dir("missing");
        let path = dir.join("nested").join("opencode").join(CONFIG_JSON);

        let outcome = ensure_mcp_in_file(&path, "/opt/tapd-mcp").unwrap();
        assert!(outcome.changed);
        assert!(outcome.backup_path.is_none());

        let written: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(written.get("$schema"), Some(&json!(CONFIG_SCHEMA)));
        assert_eq!(
            written.pointer("/mcp/servers/tapd"),
            Some(&json!({ "type": "local", "command": ["/opt/tapd-mcp"] }))
        );

        cleanup(&dir);
    }

    #[test]
    fn second_import_is_noop() {
        let dir = temp_dir("idempotent");
        let path = dir.join(CONFIG_JSON);

        let first = ensure_mcp_in_file(&path, "/opt/tapd-mcp").unwrap();
        assert!(first.changed);
        let written = std::fs::read_to_string(&path).unwrap();

        let second = ensure_mcp_in_file(&path, "/opt/tapd-mcp").unwrap();
        assert!(!second.changed);
        assert!(second.backup_path.is_none());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), written);
        assert!(backup_files(&dir).is_empty());

        cleanup(&dir);
    }

    #[test]
    fn invalid_json_is_rejected_without_changes() {
        let dir = temp_dir("invalid");
        let path = dir.join(CONFIG_JSONC);
        let original = "{\n  // JSONC comment\n  \"$schema\": \"https://opencode.ai/config.json\"\n}\n";
        std::fs::write(&path, original).unwrap();

        let error = ensure_mcp_in_file(&path, "/opt/tapd-mcp").unwrap_err();
        assert!(error.contains("JSON"), "unexpected error: {error}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
        assert!(backup_files(&dir).is_empty());

        cleanup(&dir);
    }

    #[test]
    fn non_object_mcp_is_rejected_without_changes() {
        let dir = temp_dir("shape");
        let path = dir.join(CONFIG_JSON);
        let original = r#"{"mcp": "not-an-object"}"#;
        std::fs::write(&path, original).unwrap();

        let error = ensure_mcp_in_file(&path, "/opt/tapd-mcp").unwrap_err();
        assert!(error.contains("mcp"), "unexpected error: {error}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
        assert!(backup_files(&dir).is_empty());

        cleanup(&dir);
    }

    #[test]
    fn detects_existing_entry_and_ignores_missing_or_bad_files() {
        let dir = temp_dir("detect");
        let path = dir.join(CONFIG_JSON);
        std::fs::write(
            &path,
            r#"{"mcp":{"servers":{"tapd":{"type":"local","command":["/opt/tapd-mcp"]}}}}"#,
        )
        .unwrap();

        assert!(is_imported_in(&path, "/opt/tapd-mcp"));
        assert!(!is_imported_in(&path, "/opt/other"));
        assert!(!is_imported_in(&dir.join("missing.json"), "/opt/tapd-mcp"));

        let broken = dir.join("broken.json");
        std::fs::write(&broken, "{ // comment\n}").unwrap();
        assert!(!is_imported_in(&broken, "/opt/tapd-mcp"));

        cleanup(&dir);
    }

    #[test]
    fn parses_labeled_debug_paths() {
        let output = "\
home       /Users/me
data       /Users/me/.local/share/opencode
cache      /Users/me/.cache/opencode
config     /Users/me/.config/opencode
state      /Users/me/.local/state/opencode
db         /Users/me/.local/share/opencode/opencode.db
";
        assert_eq!(
            parse_debug_paths(output),
            Some(PathBuf::from("/Users/me/.config/opencode/opencode.json"))
        );
    }

    #[test]
    fn parses_config_file_path_in_debug_output() {
        let output = "config file /Users/me/.config/opencode/opencode.jsonc\n";
        assert_eq!(
            parse_debug_paths(output),
            Some(PathBuf::from(
                "/Users/me/.config/opencode/opencode.jsonc"
            ))
        );

        let unlabeled = "/Users/me/.config/opencode/opencode.json\n";
        assert_eq!(
            parse_debug_paths(unlabeled),
            Some(PathBuf::from("/Users/me/.config/opencode/opencode.json"))
        );
    }

    #[test]
    fn prefers_jsonc_in_config_directory() {
        let dir = temp_dir("jsonc-preference");
        let jsonc = dir.join(CONFIG_JSONC);
        std::fs::write(&jsonc, "{}").unwrap();

        assert_eq!(config_file_for_dir(&dir), jsonc);

        cleanup(&dir);
    }
}
