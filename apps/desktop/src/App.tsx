import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import clsx from "clsx";
import {
  AlertTriangle,
  Bug,
  CheckCircle2,
  FileJson,
  Loader2,
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
  type AppInfo,
  type BugDetail,
  type BugSummary,
  type ExportResult,
  type SessionStatus,
  type WorkspaceContext,
} from "./lib/api";
import { BugDetailDrawer } from "./components/BugDetailDrawer";
import { BugListView } from "./components/BugListView";
import { CapturesPage } from "./components/CapturesPage";
import { LoginGate } from "./components/LoginGate";
import { SettingsPage } from "./components/SettingsPage";
import { Badge, Button, Spinner } from "./components/ui";

type View = "bugs" | "captures" | "settings";
type Scope = "mine" | "all";
type Toast = { kind: "ok" | "error"; text: string };

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

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      showToast("ok", "已复制");
    } catch (error) {
      showToast("error", `复制失败：${String(error)}`);
    }
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
    <div className="flex h-full bg-slate-50">
      <aside className="flex w-64 shrink-0 flex-col bg-ink-900 text-slate-300">
        <div className="flex items-center gap-3 px-5 py-5">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-sky-400 to-emerald-400 text-ink-900 shadow-lg shadow-sky-500/20">
            <Bug size={20} strokeWidth={2.4} />
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-white">TAPD Client</div>
            <div className="text-[11px] uppercase tracking-widest text-slate-500">
              {context?.user.company || "workspace"}
            </div>
          </div>
        </div>

        <nav className="flex flex-col gap-1 px-3">
          {NAV.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setView(item.id)}
              className={clsx(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition",
                view === item.id
                  ? "bg-white/10 text-white"
                  : "text-slate-400 hover:bg-white/5 hover:text-slate-200",
              )}
            >
              <span className={view === item.id ? "text-sky-400" : "text-slate-500"}>
                {item.icon}
              </span>
              <span className="flex-1">{item.label}</span>
            </button>
          ))}
        </nav>

        <div className="mt-5 flex min-h-0 flex-1 flex-col">
          <div className="flex items-center justify-between px-5 pb-1 text-[10px] uppercase tracking-widest text-slate-500">
            <span>项目</span>
            {contextLoading ? <Spinner className="text-slate-500" /> : null}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
            {contextError ? (
              <div className="rounded-lg border border-rose-500/20 bg-rose-500/10 p-2.5 text-[11px] leading-5 text-rose-200">
                <div className="break-all">{contextError}</div>
                <button
                  type="button"
                  onClick={() => void loadContext()}
                  className="mt-2 inline-flex items-center gap-1 rounded border border-rose-400/30 px-2 py-1 text-[10px]"
                >
                  <RefreshCw size={10} />
                  重试
                </button>
              </div>
            ) : null}

            {!context && contextLoading ? (
              <div className="px-2 py-2 text-[11px] text-slate-500">读取项目…</div>
            ) : null}

            {context?.workspaces.map((item) => {
              const active = item.id === workspaceId;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => selectWorkspace(item.id)}
                  className={clsx(
                    "mb-1 flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-xs transition",
                    active
                      ? "bg-white/10 text-white"
                      : "text-slate-400 hover:bg-white/5 hover:text-slate-200",
                  )}
                >
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: item.logoColor || "#0ea5e9" }}
                  />
                  <span className="min-w-0 flex-1 truncate">{item.name}</span>
                  {active ? <span className="h-1.5 w-1.5 rounded-full bg-sky-400" /> : null}
                </button>
              );
            })}
          </div>
        </div>

        <div className="space-y-2 border-t border-white/5 px-5 py-4 text-[11px] text-slate-500">
          <div className="flex items-center gap-2">
            {info.loggedIn ? (
              <Wifi size={12} className="text-emerald-400" />
            ) : (
              <WifiOff size={12} className="text-amber-400" />
            )}
            <span className="truncate">
              {context?.user.nick || info.me || "已登录"}
              {context?.user.userId ? ` · ${context.user.userId}` : ""}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span>v{info.version}</span>
            {info.runtimePort ? <Badge tone="slate">MCP :{info.runtimePort}</Badge> : null}
          </div>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-slate-200 bg-white px-5">
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold text-slate-900">{title}</h1>
            <p className="truncate text-[11px] text-slate-500">{subtitle}</p>
          </div>
          <div className="flex items-center gap-2">
            {scope === "mine" ? (
              <Badge tone="blue">我的缺陷</Badge>
            ) : (
              <Badge tone="neutral">全部缺陷</Badge>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setRefreshToken((token) => token + 1);
                void refreshBase();
              }}
              icon={<RefreshCw size={13} />}
            >
              刷新
            </Button>
          </div>
        </header>

        {view === "bugs" ? (
          contextError ? (
            <div className="p-5">
              <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-xs leading-6 text-rose-700">
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
              />
            )}
          </div>
        )}
      </main>

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
        onOpenPath={openPath}
      />

      {toastNode}
    </div>
  );
}
