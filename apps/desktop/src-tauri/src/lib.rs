mod agent;
mod cache;
mod commands;
mod export;
mod feature_router;
mod mcp;
mod mcp_import;
mod notification;
mod open_with;
mod opencode;
mod server;
mod session;
mod state;

use std::sync::Arc;

use tapd_core::{
    config::ConfigStore,
    paths::AppPaths,
    runtime::RuntimeInfo,
};
use tauri::{Manager, RunEvent};
use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

use crate::state::AppState;

pub fn run() {
    let paths = match AppPaths::resolve() {
        Ok(paths) => paths,
        Err(error) => {
            eprintln!("failed to resolve application paths: {error}");
            std::process::exit(1);
        }
    };

    init_tracing(&paths);

    let config_store = ConfigStore::new(paths.config_file.clone());
    let config = config_store.load();
    let state = Arc::new(AppState::new(paths, config_store, config));
    let setup_state = state.clone();

    tauri::Builder::default()
        .manage(state.clone())
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::session_status,
            commands::session_show,
            commands::session_hide,
            commands::session_mark_logged_in,
            commands::session_logout,
            commands::session_ping,
            commands::session_http,
            commands::workspace_context,
            commands::bug_list,
            commands::bug_detail,
            export::export_bug_md,
            commands::set_current_user,
            commands::ensure_window_width,
            commands::mcp_config,
            feature_router::feature_command,
            commands::set_last_workspace,
            commands::capture_snapshot,
            commands::capture_clear,
            commands::capture_export,
            commands::open_path,
            commands::open_media,
            commands::media_endpoint,
            commands::list_dirs,
            commands::open_targets,
            commands::set_open_target,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            let state = setup_state.clone();

            let server_state = state.clone();
            let server_handle = handle.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = server::run(server_handle, server_state).await {
                    tracing::error!(%error, "local API server stopped");
                }
            });

            let visible = !state.config_snapshot().logged_in;
            if let Err(error) = session::ensure_session_window(&handle, &state, visible) {
                tracing::error!(%error, "failed to create TAPD session window");
            }

            notification::init(&handle, state.clone());
            agent::init(&handle, state.clone());
            session::spawn_session_watcher(handle, state);

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(state) = app.try_state::<Arc<AppState>>() {
                    RuntimeInfo::clear(&state.paths.runtime_file);
                }
            }
        });
}

fn init_tracing(paths: &AppPaths) {
    let appender = tracing_appender::rolling::daily(&paths.logs_dir, "tapd-client.log");
    let (non_blocking, guard) = tracing_appender::non_blocking(appender);
    // Keep the writer alive for the whole process lifetime.
    std::mem::forget(guard);

    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| {
        EnvFilter::new("info,tapd_client_lib=debug,tapd_core=debug")
    });

    let _ = tracing_subscriber::registry()
        .with(filter)
        .with(fmt::layer().with_writer(non_blocking).with_ansi(false))
        .with(fmt::layer().with_writer(std::io::stderr))
        .try_init();
}
