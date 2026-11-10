import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import clsx from "clsx";
import {
  AlertTriangle,
  Bug,
  CheckCircle2,
  FileJson,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Settings as SettingsIcon,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";

import {
  api,
  onSessionChanged,
  onSessionUrl,
  setMediaEndpoint,
  type AppInfo,
  type BugDetail,
  type BugSummary,
  type ExportResult,
  type OpenMediaMode,
  type SessionStatus,
  type WorkspaceContext,
} from "./lib/api";
import { BugDetailDrawer } from "./components/BugDetailDrawer";
import { BugListView } from "./components/BugListView";
import { CapturesPage } from "./components/CapturesPage";
import { LoginGate } from "./components/LoginGate";
import { SettingsPage } from "./components/SettingsPage";
import { Button, Spinner } from "./components/ui";
import { featureCommand } from "./lib/feature";

type View = "bugs" | "captures" | "settings";
type Scope = "mine" | "all";
type Toast = { kind: "ok" | "error"; text: string };

// Project sidebar sizing. Dragging below the minimum collapses it.
const DEFAULT_SIDEBAR_WIDTH = 264;
const MIN_SIDEBAR_WIDTH = 208;
const MAX_SIDEBAR_WIDTH = 420;

const NAV: Array<{ id: View; label: string; icon: ReactNode }> = [
  { id: "bugs", label: "缺陷", icon: <Bug size={15} /> },
  { id: "captures", label: "接口抓包", icon: <FileJson size={15} /> },
  { id: "settings", label: "设置", icon: <SettingsIcon size={15} /> },
];

export default function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [status, setStatus] = useState<SessionStatus | null>(null);
  const [context, setContext] = useState<WorkspaceContext | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextError, setContextError] = useState<string | null>(null);
  const [workspaceId, setWorkspaceId] = useState("");
  const [scope, setScope] = useState<Scope>("mine");
  const [view, setView] = useState<View>("bugs");
  const [toast, setToast] = useState<Toast | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [resizingSidebar, setResizingSidebar] = useState(false);

  const [detailOpen, setDetailOpen] = useState(false);
  const [detail, setDetail] = useState<BugDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [lastExport, setLastExport] = useState<ExportResult | null>(null);

  const infoRef = useRef<AppInfo | null>(null);
  infoRef.current = info;

  const showToast = useCallback((kind: Toast["kind"], text: string) => {
    setToast({ kind, text });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 4200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const refreshBase = useCallback(async () => {
    try {
      const [nextInfo, nextStatus] = await Promise.all([
        api.appInfo(),
        api.sessionStatus(),
      ]);
      setInfo(nextInfo);
      setStatus(nextStatus);
      setMediaEndpoint(nextInfo);
    } catch (error) {
      showToast("error", String(error));
    }
  }, [showToast]);

  const loadContext = useCallback(async () => {
    setContextLoading(true);
    setContextError(null);
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const next = await api.workspaceContext();
          setContext(next);
          if (next.user.nick) {
            void api.setCurrentUser(next.user.nick);
          }
          const lastId = infoRef.current?.lastWorkspaceId;
          setWorkspaceId((current) => {
            if (current) return current;
            if (lastId && next.workspaces.some((item) => item.id === lastId)) return lastId;
            return next.workspaces[0]?.id ?? "";
          });
          return;
        } catch (error) {
          if (attempt === 2) {
            setContextError(String(error));
            return;
          }
          await new Promise((resolve) => window.setTimeout(resolve, 700));
        }
      }
    } finally {
      setContextLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshBase();
    const unlisteners: Array<() => void> = [];
    void onSessionChanged(() => {
      void refreshBase();
      setRefreshToken((token) => token + 1);
    }).then((unlisten) => unlisteners.push(unlisten));
    void onSessionUrl((url) => {
      setStatus((previous) => (previous ? { ...previous, url } : previous));
    }).then((unlisten) => unlisteners.push(unlisten));

    return () => unlisteners.forEach((unlisten) => unlisten());
  }, [refreshBase]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<{ workspaceId: string; bugId: string }>(
      "notification://open-bug",
      (event) => {
        const { workspaceId, bugId } = event.payload;
        setView("bugs");
        setWorkspaceId(workspaceId);
        void api.setLastWorkspace(workspaceId);
        setDetailOpen(true);
        setDetail(null);
        setDetailError(null);
        setLastExport(null);
        setDetailLoading(true);
        void api
          .bugDetail(workspaceId, bugId)
          .then((next) => setDetail(next))
          .catch((error) => setDetailError(String(error)))
          .finally(() => setDetailLoading(false));
      },
    ).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen("data://refresh", () => {
      setRefreshToken((token) => token + 1);
      void refreshBase();
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, [refreshBase]);

  useEffect(() => {
    if (info?.loggedIn && !context && !contextLoading && !contextError) {
      void loadContext();
    }
    if (!info?.loggedIn) {
      setContext(null);
      setContextError(null);
      setWorkspaceId("");
    }
  }, [info?.loggedIn, context, contextLoading, contextError, loadContext]);

  const workspace =
    context?.workspaces.find((item) => item.id === workspaceId) ?? null;

  const selectWorkspace = (id: string) => {
    setWorkspaceId(id);
    setView("bugs");
    setDetailOpen(false);
    void api.setLastWorkspace(id);
  };

  const openBug = async (bug: BugSummary) => {
    setDetailOpen(true);
    setDetail(null);
    setDetailError(null);
    setLastExport(null);
    setDetailLoading(true);
    try {
      const next = await api.bugDetail(bug.workspaceId, bug.id);
      setDetail(next);
    } catch (error) {
      setDetailError(String(error));
    } finally {
      setDetailLoading(false);
    }
  };

  const handleExport = async (target: BugDetail) => {
    setExporting(true);
    try {
      const name =
        context?.workspaces.find((item) => item.id === target.workspaceId)?.name ?? null;
      const result = await api.exportBugMd(target.workspaceId, target.id, name);
      setLastExport(result);
      showToast("ok", `已导出 ${result.assetCount} 个资源：${result.markdownPath}`);
    } catch (error) {
      showToast("error", String(error));
    } finally {
      setExporting(false);
    }
  };

  const enqueueAgent = async (target: {
    workspaceId: string;
    id: string;
    title: string;
    severityLabel: string;
    priorityLabel: string;
    workspaceName?: string;
  }) => {
    const workspaceName =
      target.workspaceName ||
      context?.workspaces.find((item) => item.id === target.workspaceId)?.name ||
      null;

    try {
      await featureCommand("agent_enqueue_bug", {
        workspaceId: target.workspaceId,
        bugId: target.id,
        workspaceName,
        title: target.title,
        severity: target.severityLabel,
        priority: target.priorityLabel,
      });
      showToast("ok", "已加入 Agent 队列");
    } catch (error) {
      showToast("error", String(error));
      return;
    }

    try {
      await featureCommand("agent_console_open");
    } catch (error) {
      showToast("error", String(error));
    }
  };

  const handleAgentFix = (target: BugDetail) => void enqueueAgent(target);

  const handleLogout = () => {
    if (!window.confirm("退出登录会清除本地 TAPD 会话数据，确定继续吗？")) return;
    void (async () => {
      try {
        await api.logout();
        setContext(null);
        setWorkspaceId("");
        setDetailOpen(false);
        showToast("ok", "已退出登录");
        await refreshBase();
      } catch (error) {
        showToast("error", String(error));
      }
    })();
  };

  const openPath = (path: string) => {
    void api.openPath(path).catch((error) => showToast("error", String(error)));
  };

  const openMedia = async (
    url: string,
    mode: OpenMediaMode,
    kind?: string,
    target?: string,
  ) => {
    try {
      // Opening is self-evident (the app comes to the front); only failures
      // need a toast.
      await api.openMedia(url, mode, kind, target);
    } catch (error) {
      showToast("error", String(error));
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      showToast("ok", "已复制");
    } catch (error) {
      showToast("error", `复制失败：${String(error)}`);
    }
  };

  const startSidebarResize = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarCollapsed ? 0 : sidebarWidth;
    if (sidebarCollapsed) {
      // Dragging out of the collapsed state starts from the minimum width.
      setSidebarCollapsed(false);
      setSidebarWidth(MIN_SIDEBAR_WIDTH);
    }
    setResizingSidebar(true);

    const stop = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setResizingSidebar(false);
    };

    const onMove = (move: MouseEvent) => {
      const next = Math.max(0, Math.min(MAX_SIDEBAR_WIDTH, startWidth + (move.clientX - startX)));
      // Below the minimum the sidebar gives up and collapses with a transition.
      if (next < MIN_SIDEBAR_WIDTH) {
        stop();
        setSidebarCollapsed(true);
        setSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
        return;
      }
      setSidebarWidth(next);
    };

    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setResizingSidebar(false);
      setSidebarWidth((width) => Math.max(MIN_SIDEBAR_WIDTH, width));
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const toastNode = toast ? (
    <div
      className={clsx(
        "fixed bottom-5 right-5 z-[60] flex max-w-md items-start gap-2 rounded-xl px-4 py-3 text-sm shadow-2xl",
        toast.kind === "ok" ? "bg-slate-900 text-slate-100" : "bg-rose-600 text-white",
      )}
    >
      {toast.kind === "ok" ? (
        <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-emerald-400" />
      ) : (
        <AlertTriangle size={16} className="mt-0.5 shrink-0" />
      )}
      <span className="break-all">{toast.text}</span>
      <button
        type="button"
        onClick={() => setToast(null)}
        className="ml-2 shrink-0 opacity-60 transition hover:opacity-100"
      >
        <X size={14} />
      </button>
    </div>
  ) : null;

  if (!info) {
    return (
      <div className="flex h-full items-center justify-center gap-2 bg-slate-50 text-xs text-slate-400">
        <Loader2 size={16} className="animate-spin" />
        正在启动客户端…
      </div>
    );
  }

  if (!info.loggedIn) {
    return (
      <>
        <LoginGate
          info={info}
          status={status}
          onRefresh={() => void refreshBase()}
          onToast={showToast}
        />
        {toastNode}
      </>
    );
  }

  const title =
    view === "bugs"
      ? workspace?.name ?? "缺陷"
      : view === "captures"
        ? "接口抓包"
        : "设置";
  const subtitle =
    view === "bugs"
      ? workspace
        ? `项目 ${workspace.id} · ${scope === "mine" ? "我负责的" : "全部缺陷"}`
        : "选择左侧项目开始"
      : view === "captures"
        ? "查看隐藏 WebView 捕获的 TAPD 接口"
        : "账户、项目与本地数据";

  return (
    <div
      className={clsx(
        "flex h-full flex-col overflow-hidden bg-[#f4f4f2] text-slate-900",
        resizingSidebar && "select-none",
      )}
    >
      {/* macOS traffic lights live over this strip; whole strip drags the window. */}
      <div
        className="flex h-11 shrink-0 items-center gap-2 px-4"
        data-tauri-drag-region
      >
        <span className="ml-[62px] text-[11px] font-medium uppercase tracking-[0.14em] text-slate-400">
          TAPD Client
        </span>
        <span className="flex-1" data-tauri-drag-region />
        {contextLoading ? <Spinner className="text-slate-300" /> : null}
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Icon rail */}
        <div className="flex w-[52px] shrink-0 flex-col items-center pb-2">
          <div className="flex flex-col items-center gap-1">
            {NAV.filter((item) => item.id !== "settings").map((item) => (
              <button
                key={item.id}
                type="button"
                title={item.label}
                aria-label={item.label}
                onClick={() => setView(item.id)}
                className={clsx(
                  "grid h-9 w-9 place-items-center rounded-xl transition",
                  view === item.id
                    ? "bg-black/[0.07] text-slate-900"
                    : "text-slate-500 hover:bg-black/[0.04] hover:text-slate-700",
                )}
              >
                {item.icon}
              </button>
            ))}
          </div>
          <div className="flex-1" data-tauri-drag-region />
          <button
            type="button"
            title="设置"
            aria-label="设置"
            onClick={() => setView("settings")}
            className={clsx(
              "grid h-9 w-9 place-items-center rounded-xl transition",
              view === "settings"
                ? "bg-black/[0.07] text-slate-900"
                : "text-slate-500 hover:bg-black/[0.04] hover:text-slate-700",
            )}
          >
            <SettingsIcon size={15} />
          </button>
        </div>

        {/* Project sidebar (resizable) */}
        <div
          className={clsx(
            "relative flex shrink-0 flex-col overflow-hidden",
            !resizingSidebar && "transition-[width] duration-200 ease-out",
          )}
          style={{ width: sidebarCollapsed ? 0 : sidebarWidth }}
        >
          <div className="flex h-9 shrink-0 items-center gap-1 pr-1" data-tauri-drag-region>
            <span className="min-w-0 flex-1 truncate px-2 text-[13px] font-semibold text-slate-800">
              项目
            </span>
            {context?.workspaces.length ? (
              <span className="text-[11px] tabular-nums text-slate-400">
                {context.workspaces.length}
              </span>
            ) : null}
            <button
              type="button"
              aria-label="收起项目列表"
              title="收起项目列表"
              onClick={() => setSidebarCollapsed(true)}
              className="grid h-7 w-7 place-items-center rounded-lg text-slate-400 transition hover:bg-black/[0.05] hover:text-slate-600"
            >
              <PanelLeftClose size={14} />
            </button>
          </div>

          <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
            {contextError ? (
              <div className="rounded-xl bg-rose-50 p-2.5 text-[11px] leading-5 text-rose-700 ring-1 ring-rose-100">
                <div className="break-all">{contextError}</div>
                <button
                  type="button"
                  onClick={() => void loadContext()}
                  className="mt-2 inline-flex items-center gap-1 rounded-md bg-white px-2 py-1 text-[10px] text-rose-700 ring-1 ring-rose-200 transition hover:bg-rose-100"
                >
                  <RefreshCw size={10} />
                  重试
                </button>
              </div>
            ) : null}

            {!context && contextLoading ? (
              <div className="px-2 py-2 text-[11px] text-slate-400">读取项目…</div>
            ) : null}

            {context?.workspaces.map((item) => {
              const active = item.id === workspaceId;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => selectWorkspace(item.id)}
                  className={clsx(
                    "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-left text-[13px] transition",
                    active
                      ? "bg-black/[0.06] font-medium text-slate-900"
                      : "text-slate-600 hover:bg-black/[0.04]",
                  )}
                >
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: item.logoColor || "#0ea5e9" }}
                  />
                  <span className="min-w-0 flex-1 truncate">{item.name}</span>
                  {active ? (
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
                  ) : null}
                </button>
              );
            })}
          </div>

          <div className="space-y-1.5 border-t border-black/[0.06] px-3 py-2.5 text-[11px] text-slate-500">
            <div className="flex items-center gap-2">
              {info.loggedIn ? (
                <Wifi size={12} className="text-emerald-500" />
              ) : (
                <WifiOff size={12} className="text-amber-500" />
              )}
              <span className="truncate">
                {context?.user.nick || info.me || "已登录"}
                {context?.user.userId ? ` · ${context.user.userId}` : ""}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-400">v{info.version}</span>
              {info.runtimePort ? (
                <span className="rounded-md bg-black/[0.05] px-1.5 py-0.5 text-[10px] text-slate-500">
                  MCP :{info.runtimePort}
                </span>
              ) : null}
            </div>
          </div>

          <button
            type="button"
            aria-label="调整项目列表宽度"
            title="拖动调整宽度，拖到很窄会自动收起"
            onMouseDown={startSidebarResize}
            className={clsx(
              "absolute right-0 top-0 z-10 h-full w-1.5 cursor-col-resize",
              resizingSidebar ? "bg-sky-400/50" : "bg-transparent transition hover:bg-black/[0.06]",
            )}
          />
        </div>

        {/* Content panel */}
        <main className="mb-2 mr-2 flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl bg-white shadow-[0_1px_3px_rgba(15,23,42,0.06)] ring-1 ring-black/[0.06]">
          <header className="flex h-12 shrink-0 items-center gap-1.5 px-2" data-tauri-drag-region>
            <button
              type="button"
              aria-label={sidebarCollapsed ? "展开项目列表" : "收起项目列表"}
              title={sidebarCollapsed ? "展开项目列表" : "收起项目列表"}
              onClick={() => setSidebarCollapsed((current) => !current)}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-slate-400 transition hover:bg-black/[0.05] hover:text-slate-700"
            >
              {sidebarCollapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
            </button>

            <div className="min-w-0 flex-1 px-1">
              <h1 className="truncate text-[13px] font-semibold leading-5 text-slate-900">
                {title}
              </h1>
              <p className="truncate text-[11px] leading-4 text-slate-400">{subtitle}</p>
            </div>

          </header>

          {view === "bugs" ? (
            contextError ? (
              <div className="p-5">
                <div className="rounded-xl bg-rose-50 p-4 text-xs leading-6 text-rose-700 ring-1 ring-rose-100">
                  <div className="font-semibold">项目列表加载失败</div>
                  <div className="mt-1 break-all">{contextError}</div>
                  <Button
                    size="sm"
                    className="mt-3"
                    onClick={() => void loadContext()}
                    icon={<RefreshCw size={13} />}
                  >
                    重新加载
                  </Button>
                </div>
              </div>
            ) : workspace ? (
              <BugListView
                key={workspace.id}
                workspace={workspace}
                me={context?.user.nick ?? info.me}
                scope={scope}
                onScopeChange={setScope}
                onOpenBug={(bug) => void openBug(bug)}
                onOpenWeb={(url) => openPath(url)}
                onCopyLink={(url) => void copy(url)}
                onAgentFix={(bug) => void enqueueAgent(bug)}
                refreshToken={refreshToken}
              />
            ) : (
              <div className="flex flex-1 items-center justify-center">
                <div className="text-center">
                  <Spinner className="mx-auto" />
                  <p className="mt-2 text-xs text-slate-400">正在加载项目…</p>
                </div>
              </div>
            )
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto p-5">
              {view === "captures" ? (
                <CapturesPage toast={showToast} onOpenPath={openPath} />
              ) : (
                <SettingsPage
                  info={info}
                  status={status}
                  context={context}
                  onShowLogin={() => {
                    void api
                      .sessionShow()
                      .then(() => showToast("ok", "已打开 TAPD 窗口"))
                      .catch((error) => showToast("error", String(error)));
                  }}
                  onLogout={handleLogout}
                  onRefresh={() => {
                    void refreshBase();
                    setRefreshToken((token) => token + 1);
                  }}
                  onOpenPath={openPath}
                  onCopy={(text) => void copy(text)}
                  toast={showToast}
                />
              )}
            </div>
          )}
        </main>
      </div>

      <BugDetailDrawer
        open={detailOpen}
        detail={detail}
        loading={detailLoading}
        error={detailError}
        exporting={exporting}
        lastExport={lastExport}
        onClose={() => setDetailOpen(false)}
        onOpenWeb={(url) => openPath(url)}
        onCopy={(text) => void copy(text)}
        onExport={(target) => void handleExport(target)}
        onAgentFix={(target) => void handleAgentFix(target)}
        onOpenPath={openPath}
        onOpenMedia={(url, mode, kind, target) => void openMedia(url, mode, kind, target)}
      />

      {toastNode}
    </div>
  );
}
