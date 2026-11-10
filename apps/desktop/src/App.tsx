import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import clsx from "clsx";
import {
  AlertTriangle,
  ArrowUpCircle,
  Bot,
  Bug,
  CheckCircle2,
  ChevronRight,
  FolderGit2,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  RefreshCw,
  Settings as SettingsIcon,
  X,
} from "lucide-react";

import {
  api,
  onSessionChanged,
  setMediaEndpoint,
  type AppInfo,
  type BugDetail,
  type BugSummary,
  type ExportResult,
  type OpenMediaMode,
  type WorkspaceContext,
  type WorkspaceMember,
} from "./lib/api";
import { agentApi } from "./lib/agent";
import { cacheApi } from "./lib/cache";
import {
  beginRefresh,
  getRefreshing,
  subscribeRefresh,
} from "./lib/refresh";
import {
  getUpdateSnapshot,
  startUpdateStore,
  subscribeUpdate,
} from "./lib/update";
import { AgentPage } from "./components/AgentPage";
import { AccountPage } from "./components/AccountPage";
import { Avatar } from "./components/Avatar";
import { BugDetailDrawer } from "./components/BugDetailDrawer";
import { FolderPicker } from "./components/FolderPicker";
import { BugListView } from "./components/BugListView";
import { LoginGate } from "./components/LoginGate";
import { McpPage } from "./components/McpPage";
import { Onboarding } from "./components/Onboarding";
import { ProjectSettings } from "./components/ProjectSettings";
import { SettingsPage } from "./components/SettingsPage";
import { ScrollingName } from "./components/ScrollingName";
import { SkeletonRows } from "./components/Skeleton";
import { Button } from "./components/ui";

type View = "bugs" | "projects" | "agent" | "mcp" | "settings" | "account";
type Scope = "mine" | "all";
type Toast = { kind: "ok" | "error"; text: string };

/** Minimal bug shape needed to enqueue an Agent task. */
type AgentTarget = {
  workspaceId: string;
  id: string;
  title: string;
  severityLabel: string;
  priorityLabel: string;
  workspaceName?: string;
};

// Project sidebar sizing. Dragging below the minimum collapses it.
const MIN_SIDEBAR_WIDTH = 168;
const MAX_SIDEBAR_WIDTH = 300;
/** Content area that must stay usable; the sidebar yields space below this. */
const MIN_CONTENT_WIDTH = 460;
/** Codex-style right detail pane. */
const DETAIL_PANEL_WIDTH = 520;
const DETAIL_MIN_WIDTH = 360;
const DETAIL_MAX_WIDTH = 760;
/** Minimum width the bug list keeps while the detail pane is open. */
const DETAIL_CONTENT_MIN = 340;
/** Rail + sidebar gap + panel margins (with a small resize buffer). */
const LAYOUT_GUTTER = 32;

/** People directory refresh window; matches the two-hour update check. */
const MEMBERS_TTL_MS = 2 * 60 * 60 * 1000;

/** Default sidebar width for the current window: compact, project names are short. */
const defaultSidebarWidth = (viewport: number): number =>
  Math.round(Math.min(Math.max(viewport * 0.15, 176), 208));

const RAIL_ANIM: Record<string, string> = {
  bugs: "rail-bug-jump",
  projects: "rail-folder-bounce",
  agent: "rail-bot-shake",
  mcp: "rail-plug-rise",
  settings: "rail-settings-spin",
  account: "rail-avatar-pop",
};

const NAV: Array<{ id: View; label: string; icon: ReactNode }> = [
  { id: "bugs", label: "缺陷", icon: <Bug size={15} /> },
  { id: "projects", label: "项目", icon: <FolderGit2 size={15} /> },
  { id: "agent", label: "Agent", icon: <Bot size={15} /> },
  { id: "mcp", label: "MCP", icon: <Plug size={15} /> },
  { id: "settings", label: "设置", icon: <SettingsIcon size={15} /> },
];

export default function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [context, setContext] = useState<WorkspaceContext | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextError, setContextError] = useState<string | null>(null);
  const [workspaceId, setWorkspaceId] = useState("");
  const [scope, setScope] = useState<Scope>("mine");
  const [view, setView] = useState<View>("bugs");
  const [railAnim, setRailAnim] = useState<{ id: string; token: number } | null>(null);
  const railAnimTimer = useRef<number | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  /** Workspace people directory, keyed by workspace id. */
  const [membersByWorkspace, setMembersByWorkspace] = useState<
    Record<string, WorkspaceMember[]>
  >({});
  const [membersLoading, setMembersLoading] = useState<Record<string, boolean>>({});
  const membersRef = useRef<Record<string, WorkspaceMember[]>>({});
  const membersFetchedAtRef = useRef<Record<string, number>>({});
  const membersInFlightRef = useRef<
    Record<string, Promise<WorkspaceMember[]> | undefined>
  >({});
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === "undefined" ? 1280 : window.innerWidth,
  );
  const [sidebarWidth, setSidebarWidth] = useState(() => defaultSidebarWidth(1280));
  const [sidebarSized, setSidebarSized] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  /** Temporarily reveals the project list even when the window is too narrow. */
  const [sidebarPeek, setSidebarPeek] = useState(false);
  const [resizingSidebar, setResizingSidebar] = useState(false);
  /** Set when the user asks for an Agent fix without a configured folder. */
  const [pendingAgent, setPendingAgent] = useState<AgentTarget | null>(null);
  /** Task the island capsule asked us to focus in the Agent tab. */
  const [agentFocusTaskId, setAgentFocusTaskId] = useState<string | null>(null);
  /** Locally hidden TAPD projects (persisted in config.json). */
  const [hiddenWorkspaceIds, setHiddenWorkspaceIds] = useState<string[]>([]);
  const hiddenInitializedRef = useRef(false);
  /** Right-click context menu for a project row. */
  const [projectMenu, setProjectMenu] = useState<{
    id: string;
    name: string;
    x: number;
    y: number;
  } | null>(null);
  /** Any live (network) refresh currently in flight; drives the title bar. */
  const refreshing = useSyncExternalStore(
    subscribeRefresh,
    getRefreshing,
    getRefreshing,
  );
  /** Background update state (checked every two hours by the Rust side). */
  const updateState = useSyncExternalStore(
    subscribeUpdate,
    getUpdateSnapshot,
    getUpdateSnapshot,
  );

  useEffect(() => {
    startUpdateStore();
  }, []);

  // Load hidden projects once from config.json. The UI is the source of truth
  // afterwards, so a background `app_info` refresh cannot revert a fresh toggle.
  useEffect(() => {
    if (hiddenInitializedRef.current || !info) return;
    hiddenInitializedRef.current = true;
    setHiddenWorkspaceIds(info.hiddenWorkspaceIds ?? []);
  }, [info]);

  // Dismiss the project context menu on any outside click / Escape.
  useEffect(() => {
    if (!projectMenu) return;
    const close = () => setProjectMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [projectMenu]);

  const visibleWorkspaces = useMemo(
    () =>
      (context?.workspaces ?? []).filter(
        (workspace) => !hiddenWorkspaceIds.includes(workspace.id),
      ),
    [context, hiddenWorkspaceIds],
  );
  /** With a single visible project the list column is pointless. */
  const projectListHidden = visibleWorkspaces.length === 1;

  // The sidebar follows the window until the user drags it once. Coalesce
  // resize events into one update per frame; window expansion fires many.
  useEffect(() => {
    let frame = 0;
    const onResize = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => setViewportWidth(window.innerWidth));
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  useEffect(() => {
    if (sidebarSized) return;
    setSidebarWidth(defaultSidebarWidth(viewportWidth));
  }, [viewportWidth, sidebarSized]);

  const [detailOpen, setDetailOpen] = useState(false);
  /** Kept true during the close animation; false unmounts the pane entirely. */
  const [detailRendered, setDetailRendered] = useState(false);
  const [detail, setDetail] = useState<BugDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailWidth, setDetailWidth] = useState(DETAIL_PANEL_WIDTH);
  const [resizingDetail, setResizingDetail] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [lastExport, setLastExport] = useState<ExportResult | null>(null);
  /** Read inside stable callbacks without re-creating them on every detail load. */
  const detailRef = useRef<BugDetail | null>(null);
  detailRef.current = detail;

  const effectiveDetailWidth = Math.max(
    DETAIL_MIN_WIDTH,
    Math.min(detailWidth, DETAIL_MAX_WIDTH),
  );

  /** Sidebar width the user chose (or the default), before auto-collapse. */
  const expandedSidebarWidth = Math.max(
    MIN_SIDEBAR_WIDTH,
    Math.min(sidebarWidth, MAX_SIDEBAR_WIDTH),
  );

  // On narrow windows the project list yields instead of squeezing the bug
  // list. This is derived state: the list comes back when there is room again.
  const autoCollapseSidebar =
    viewportWidth <
    52 +
      expandedSidebarWidth +
      (detailRendered ? DETAIL_CONTENT_MIN + effectiveDetailWidth : MIN_CONTENT_WIDTH) +
      LAYOUT_GUTTER;
  const sidebarHidden =
    projectListHidden ||
    (sidebarPeek ? false : sidebarCollapsed || autoCollapseSidebar);

  // Drop the temporary reveal once the window is wide enough again.
  useEffect(() => {
    if (!autoCollapseSidebar) setSidebarPeek(false);
  }, [autoCollapseSidebar]);

  // Never let the sidebar eat the content area on a narrow window.
  const effectiveSidebarWidth = sidebarHidden
    ? 0
    : Math.max(
        MIN_SIDEBAR_WIDTH,
        Math.min(sidebarWidth, viewportWidth - 52 - MIN_CONTENT_WIDTH),
      );

  const infoRef = useRef<AppInfo | null>(null);
  infoRef.current = info;
  /** Hidden ids readable from the stable `loadContext` callback. */
  const hiddenWorkspaceIdsRef = useRef<string[]>([]);
  hiddenWorkspaceIdsRef.current = hiddenWorkspaceIds;

  /** Whether the pane currently occupies layout (true during close animation). */
  const detailRenderedRef = useRef(false);
  detailRenderedRef.current = detailRendered;
  const detailCloseTimer = useRef<number | null>(null);
  /** Layout values readable from the stable `loadBugDetail` callback. */
  const layoutRef = useRef({
    viewportWidth,
    sidebarWidth: expandedSidebarWidth,
    detailWidth: effectiveDetailWidth,
    projectListHidden,
  });
  layoutRef.current = {
    viewportWidth,
    sidebarWidth: expandedSidebarWidth,
    detailWidth: effectiveDetailWidth,
    projectListHidden,
  };

  const showToast = useCallback((kind: Toast["kind"], text: string) => {
    setToast({ kind, text });
  }, []);

  const storeMembers = useCallback(
    (targetWorkspaceId: string, members: WorkspaceMember[], fetchedAtMs: number) => {
      membersRef.current = { ...membersRef.current, [targetWorkspaceId]: members };
      membersFetchedAtRef.current = {
        ...membersFetchedAtRef.current,
        [targetWorkspaceId]: fetchedAtMs,
      };
      setMembersByWorkspace((current) => ({
        ...current,
        [targetWorkspaceId]: members,
      }));
    },
    [],
  );

  /**
   * Returns a workspace's people directory, cache-first.
   *
   * Cached members are reused for two hours; `force` refreshes them in place
   * (also used by the background two-hour timer). Concurrent callers share one
   * request so opening several bugs does not fan out into duplicate calls.
   */
  const ensureMembers = useCallback(
    async (
      targetWorkspaceId: string,
      force = false,
    ): Promise<WorkspaceMember[]> => {
      const workspaceId = targetWorkspaceId.trim();
      if (!workspaceId) return [];

      const inFlight = membersInFlightRef.current[workspaceId];
      if (inFlight) return inFlight;

      const known = membersRef.current[workspaceId] ?? [];
      const knownAt = membersFetchedAtRef.current[workspaceId] ?? 0;
      if (!force && known.length > 0 && Date.now() - knownAt < MEMBERS_TTL_MS) {
        return known;
      }

      if (!force && known.length === 0) {
        try {
          const cached = await cacheApi.workspaceMembers(workspaceId);
          if (cached.data?.length) {
            const fetchedAtMs = (cached.fetchedAt ?? 0) * 1000;
            storeMembers(workspaceId, cached.data, fetchedAtMs);
            if (Date.now() - fetchedAtMs < MEMBERS_TTL_MS) return cached.data;
          }
        } catch {
          // A cache miss is not an error; the live request decides.
        }
      }

      setMembersLoading((current) => ({ ...current, [workspaceId]: true }));
      const request = api
        .workspaceMembers(workspaceId)
        .then((members) => {
          storeMembers(workspaceId, members, Date.now());
          return members;
        })
        .finally(() => {
          delete membersInFlightRef.current[workspaceId];
          setMembersLoading((current) => {
            const next = { ...current };
            delete next[workspaceId];
            return next;
          });
        });
      membersInFlightRef.current[workspaceId] = request;

      try {
        return await request;
      } catch (error) {
        if (!membersRef.current[workspaceId]?.length) {
          showToast("error", `处理人列表加载失败：${String(error)}`);
        }
        return membersRef.current[workspaceId] ?? [];
      }
    },
    [showToast, storeMembers],
  );

  // Load the current project's people as soon as it becomes active.
  useEffect(() => {
    if (!info?.loggedIn || !workspaceId) return;
    void ensureMembers(workspaceId);
  }, [info?.loggedIn, workspaceId, ensureMembers]);

  // Keep cached directories fresh on the same two-hour cadence as updates.
  useEffect(() => {
    if (!info?.loggedIn) return;
    const timer = window.setInterval(() => {
      const ids = new Set(
        [...Object.keys(membersRef.current), workspaceId].filter(Boolean),
      );
      for (const id of ids) void ensureMembers(id, true);
    }, MEMBERS_TTL_MS);
    return () => window.clearInterval(timer);
  }, [info?.loggedIn, workspaceId, ensureMembers]);

  // Signing out drops the directory: it belongs to the ended session.
  useEffect(() => {
    if (info?.loggedIn) return;
    membersRef.current = {};
    membersFetchedAtRef.current = {};
    membersInFlightRef.current = {};
    setMembersByWorkspace({});
    setMembersLoading({});
  }, [info?.loggedIn]);

  /** Switch views and replay the destination's rail icon animation. */
  const activateView = useCallback((id: View) => {
    setView(id);
    setRailAnim({ id, token: Date.now() });
    if (railAnimTimer.current !== null) {
      window.clearTimeout(railAnimTimer.current);
    }
    railAnimTimer.current = window.setTimeout(() => setRailAnim(null), 720);
  }, []);

  useEffect(
    () => () => {
      if (railAnimTimer.current !== null) {
        window.clearTimeout(railAnimTimer.current);
      }
    },
    [],
  );

  /** Monotonic id so a slow detail response cannot replace a newer bug. */
  const detailSeq = useRef(0);

  /**
   * Opens the detail pane cache-first. Opening it does not refresh the list and
   * does not show the global "updating" indicator — only list refreshes do.
   */
  const loadBugDetail = useCallback((targetWorkspaceId: string, bugId: string) => {
    const seq = ++detailSeq.current;
    // The owner / developer pickers need this workspace's people directory.
    void ensureMembers(targetWorkspaceId);
    // Codex-style pane: make room first (collapse the project list on narrow
    // windows, then grow the window leftwards if needed), then animate in.
    if (!detailRenderedRef.current) {
      const layout = layoutRef.current;
      const sidebarWidth = layout.projectListHidden ? 0 : layout.sidebarWidth;
      const requiredWithSidebar =
        52 +
        sidebarWidth +
        DETAIL_CONTENT_MIN +
        layout.detailWidth +
        LAYOUT_GUTTER;
      const collapseSidebar =
        !layout.projectListHidden && layout.viewportWidth < requiredWithSidebar;
      if (collapseSidebar) {
        setSidebarCollapsed(true);
        setSidebarPeek(false);
      }
      const required =
        52 +
        (collapseSidebar ? 0 : sidebarWidth) +
        DETAIL_CONTENT_MIN +
        layout.detailWidth +
        LAYOUT_GUTTER;
      void api
        .ensureWindowWidth(required)
        .catch(() => 0)
        .finally(() => {
          if (seq !== detailSeq.current) return;
          // Mount the pane at zero width, then grow it on the next frame so the
          // width transition runs from a painted starting value.
          setDetailRendered(true);
          // Two frames: the first paints the zero-width pane, the second starts
          // the width transition so the list and pane move together.
          window.requestAnimationFrame(() => {
            window.requestAnimationFrame(() => {
              if (seq === detailSeq.current) setDetailOpen(true);
            });
          });
        });
    } else {
      // Reopening during the close animation: grow back from the current width.
      if (detailCloseTimer.current !== null) {
        window.clearTimeout(detailCloseTimer.current);
        detailCloseTimer.current = null;
      }
      setDetailOpen(true);
    }
    setDetail(null);
    setDetailError(null);
    setLastExport(null);
    setDetailLoading(true);

    void (async () => {
      let hasCache = false;
      try {
        const cached = await cacheApi.bugDetail(targetWorkspaceId, bugId);
        if (seq === detailSeq.current && cached.data) {
          hasCache = true;
          setDetail(cached.data);
          setDetailLoading(false);
        }
      } catch {
        // Cache misses are not errors.
      }
      if (seq !== detailSeq.current) return;
      try {
        const next = await api.bugDetail(targetWorkspaceId, bugId);
        if (seq !== detailSeq.current) return;
        setDetail(next);
        setDetailError(null);
      } catch (error) {
        if (seq === detailSeq.current && !hasCache) {
          setDetailError(String(error));
        }
      } finally {
        if (seq === detailSeq.current) setDetailLoading(false);
      }
    })();
  }, [ensureMembers]);

  /**
   * Re-reads a bug after a write action. Unlike `loadBugDetail` it never paints
   * the (now stale) cache first, so the pane switches straight to fresh data.
   */
  const reloadBugDetail = useCallback(
    async (targetWorkspaceId: string, bugId: string) => {
      const seq = ++detailSeq.current;
      try {
        const next = await api.bugDetail(targetWorkspaceId, bugId);
        if (seq !== detailSeq.current) return;
        setDetail(next);
        setDetailError(null);
      } catch (error) {
        showToast("error", String(error));
      }
    },
    [showToast],
  );

  const bumpList = useCallback(() => {
    setRefreshToken((token) => token + 1);
  }, []);

  /** Assigns an unowned / other-owned bug to the signed-in user. */
  const claimBug = useCallback(
    async (targetWorkspaceId: string, bugId: string) => {
      const me = context?.user.nick ?? info?.me ?? null;
      if (!me) {
        showToast("error", "未能识别当前用户，无法认领");
        throw new Error("current user is unknown");
      }
      try {
        await api.bugUpdateField(targetWorkspaceId, bugId, "current_owner", me);
        showToast("ok", "已认领");
        bumpList();
        const open = detailRef.current;
        if (open?.id === bugId && open.workspaceId === targetWorkspaceId) {
          await reloadBugDetail(targetWorkspaceId, bugId);
        }
      } catch (error) {
        showToast("error", String(error));
        throw error;
      }
    },
    [context, info, bumpList, reloadBugDetail, showToast],
  );

  const claimBugFromList = useCallback(
    (bug: BugSummary) => claimBug(bug.workspaceId, bug.id),
    [claimBug],
  );

  const claimBugFromDetail = useCallback(
    (target: BugDetail) => claimBug(target.workspaceId, target.id),
    [claimBug],
  );

  const addBugComment = useCallback(
    async (target: BugDetail, comment: string) => {
      try {
        await api.bugAddComment(target.workspaceId, target.id, comment);
        showToast("ok", "评论已发表");
        bumpList();
        await reloadBugDetail(target.workspaceId, target.id);
      } catch (error) {
        showToast("error", String(error));
        throw error;
      }
    },
    [bumpList, reloadBugDetail, showToast],
  );

  const changeBugField = useCallback(
    async (target: BugDetail, field: string, value: string) => {
      try {
        await api.bugUpdateField(target.workspaceId, target.id, field, value);
        showToast("ok", field === "de" ? "开发人员已更新" : "处理人已更新");
        bumpList();
        await reloadBugDetail(target.workspaceId, target.id);
      } catch (error) {
        showToast("error", String(error));
        throw error;
      }
    },
    [bumpList, reloadBugDetail, showToast],
  );

  const transitionBug = useCallback(
    async (target: BugDetail, status: string) => {
      try {
        const result = await api.bugTransition(
          target.workspaceId,
          target.id,
          status,
        );
        showToast("ok", `状态已流转为「${result.label}」`);
        bumpList();
        await reloadBugDetail(target.workspaceId, target.id);
      } catch (error) {
        showToast("error", String(error));
        throw error;
      }
    },
    [bumpList, reloadBugDetail, showToast],
  );

  const refreshDetailMembers = useCallback(() => {
    const id = detailRef.current?.workspaceId ?? workspaceId;
    if (id) void ensureMembers(id, true);
  }, [workspaceId, ensureMembers]);

  /** Shrinks the pane away, then removes it from layout to free the content area. */
  const closeDetail = useCallback(() => {
    detailSeq.current += 1;
    setDetailOpen(false);
    if (detailCloseTimer.current !== null) {
      window.clearTimeout(detailCloseTimer.current);
    }
    detailCloseTimer.current = window.setTimeout(() => {
      detailCloseTimer.current = null;
      setDetailRendered(false);
    }, 320);
  }, []);

  useEffect(
    () => () => {
      if (detailCloseTimer.current !== null) {
        window.clearTimeout(detailCloseTimer.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 4200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const refreshBase = useCallback(async () => {
    try {
      const nextInfo = await api.appInfo();
      setInfo(nextInfo);
      setMediaEndpoint(nextInfo);
    } catch (error) {
      showToast("error", String(error));
    }
  }, [showToast]);

  const loadContext = useCallback(async () => {
    setContextLoading(true);
    setContextError(null);

    // Offline-first: render the last snapshot immediately (unless the user
    // already has newer data in memory), then refresh in the background.
    let hasCache = false;
    try {
      const cached = await cacheApi.workspaceContext();
      if (cached.data) {
        hasCache = true;
        const next = cached.data;
        setContext((current) => current ?? next);
        if (next.user.nick) {
          void api.setCurrentUser(next.user.nick);
        }
        const lastId = infoRef.current?.lastWorkspaceId;
        const hidden = new Set([
          ...(infoRef.current?.hiddenWorkspaceIds ?? []),
          ...hiddenWorkspaceIdsRef.current,
        ]);
        const visible = next.workspaces.filter((item) => !hidden.has(item.id));
        setWorkspaceId((current) => {
          if (current) return current;
          if (lastId && visible.some((item) => item.id === lastId)) return lastId;
          return visible[0]?.id ?? next.workspaces[0]?.id ?? "";
        });
      }
    } catch {
      // A missing cache is not an error; the live request below decides.
    }

    const done = beginRefresh();
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const next = await api.workspaceContext();
          setContext(next);
          if (next.user.nick) {
            void api.setCurrentUser(next.user.nick);
          }
          const lastId = infoRef.current?.lastWorkspaceId;
          const hidden = new Set([
            ...(infoRef.current?.hiddenWorkspaceIds ?? []),
            ...hiddenWorkspaceIdsRef.current,
          ]);
          const visible = next.workspaces.filter((item) => !hidden.has(item.id));
          setWorkspaceId((current) => {
            if (current) return current;
            if (lastId && visible.some((item) => item.id === lastId)) return lastId;
            return visible[0]?.id ?? next.workspaces[0]?.id ?? "";
          });
          return;
        } catch (error) {
          if (attempt === 2) {
            // Keep offline data on screen instead of replacing it with an error.
            if (!hasCache) setContextError(String(error));
            return;
          }
          await new Promise((resolve) => window.setTimeout(resolve, 700));
        }
      }
    } finally {
      setContextLoading(false);
      done();
    }
  }, []);

  // Entering the account view refreshes the identity/session snapshot, so a
  // changed company/name (or a newly cached avatar) shows up immediately.
  useEffect(() => {
    if (view !== "account") return;
    void refreshBase();
    void loadContext();
  }, [view, refreshBase, loadContext]);

  useEffect(() => {
    void refreshBase();
    const unlisteners: Array<() => void> = [];
    void onSessionChanged(() => {
      void refreshBase();
      setRefreshToken((token) => token + 1);
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
        loadBugDetail(workspaceId, bugId);
      },
    ).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, [loadBugDetail]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<{ taskId: string }>("agent://focus", (event) => {
      setView("agent");
      setAgentFocusTaskId(event.payload.taskId);
    }).then((fn) => {
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

  // The signed-in user must always be selectable, even if the member API omits
  // them (some projects only return the assignable subset).
  const detailMembers = useMemo(() => {
    const list =
      membersByWorkspace[detail?.workspaceId ?? workspaceId] ?? [];
    const myNick = context?.user.nick ?? info?.me ?? "";
    if (!myNick || list.some((member) => member.nick === myNick)) return list;
    return [
      ...list,
      { nick: myNick, userId: "", name: myNick, avatar: "" },
    ];
  }, [membersByWorkspace, detail?.workspaceId, workspaceId, context, info]);

  const selectWorkspace = (id: string) => {
    setWorkspaceId(id);
    setView("bugs");
    closeDetail();
    void api.setLastWorkspace(id);
  };

  const updateHiddenWorkspaces = async (next: string[], previous: string[]) => {
    setHiddenWorkspaceIds(next);
    try {
      await api.setHiddenWorkspaces(next);
    } catch (error) {
      setHiddenWorkspaceIds(previous);
      showToast("error", String(error));
    }
  };

  const setWorkspaceVisible = (id: string, visible: boolean) => {
    if (visible) {
      if (!hiddenWorkspaceIds.includes(id)) return;
      void updateHiddenWorkspaces(
        hiddenWorkspaceIds.filter((candidate) => candidate !== id),
        hiddenWorkspaceIds,
      );
      return;
    }

    if (visibleWorkspaces.length <= 1) {
      showToast("error", "至少保留一个项目");
      return;
    }
    if (hiddenWorkspaceIds.includes(id)) return;

    const next = [...hiddenWorkspaceIds, id];
    void updateHiddenWorkspaces(next, hiddenWorkspaceIds);
    if (workspaceId === id) {
      const replacement = visibleWorkspaces.find((item) => item.id !== id);
      if (replacement) {
        closeDetail();
        setWorkspaceId(replacement.id);
        void api.setLastWorkspace(replacement.id);
      }
    }
  };

  const hideWorkspace = (id: string) => {
    setWorkspaceVisible(id, false);
    setProjectMenu(null);
  };

  const openBug = useCallback(
    (bug: BugSummary) => {
      loadBugDetail(bug.workspaceId, bug.id);
    },
    [loadBugDetail],
  );

  /** Opens/switches the right-side detail pane without leaving the current view. */
  const openBugById = useCallback(
    (workspaceId: string, bugId: string) => {
      loadBugDetail(workspaceId, bugId);
    },
    [loadBugDetail],
  );

  const handleExport = useCallback(
    async (target: BugDetail) => {
      setExporting(true);
      try {
        const name =
          context?.workspaces.find((item) => item.id === target.workspaceId)?.name ?? null;
        const result = await api.exportBugMd(target.workspaceId, target.id, name);
        // Success is reported by the inline export panel in the detail pane;
        // a toast on top of it is just noise.
        setLastExport(result);
      } catch (error) {
        showToast("error", String(error));
      } finally {
        setExporting(false);
      }
    },
    [context, showToast],
  );

  const doEnqueueAgent = useCallback(
    async (target: AgentTarget) => {
      const workspaceName =
        target.workspaceName ||
        context?.workspaces.find((item) => item.id === target.workspaceId)?.name ||
        null;

      try {
        const { task } = await agentApi.enqueueBug({
          workspaceId: target.workspaceId,
          bugId: target.id,
          workspaceName,
          title: target.title,
          severity: target.severityLabel,
          priority: target.priorityLabel,
        });
        // The view switches to the Agent tab and focuses this task; a toast
        // on top of that is just noise.
        setAgentFocusTaskId(task.id);
        setView("agent");
      } catch (error) {
        showToast("error", String(error));
      }
    },
    [context, showToast],
  );

  /** Asks for the project folder first when none is configured, then enqueues. */
  const enqueueAgent = useCallback(
    async (target: AgentTarget) => {
      try {
        const { config } = await agentApi.configGet();
        const repoPath = (config.projects?.[target.workspaceId]?.repoPath ?? "").trim();
        if (!repoPath) {
          setPendingAgent(target);
          return;
        }
      } catch (error) {
        showToast("error", String(error));
        return;
      }
      await doEnqueueAgent(target);
    },
    [doEnqueueAgent, showToast],
  );

  const applyAgentFolder = useCallback(
    async (target: AgentTarget, path: string) => {
      setPendingAgent(null);
      try {
        const { config } = await agentApi.configGet();
        const projects = {
          ...(config.projects ?? {}),
          [target.workspaceId]: {
            ...(config.projects?.[target.workspaceId] ?? { repoPath: "", rule: "" }),
            repoPath: path,
          },
        };
        await agentApi.configSet({ projects });
      } catch (error) {
        showToast("error", String(error));
        return;
      }
      await doEnqueueAgent(target);
    },
    [doEnqueueAgent, showToast],
  );

  const handleAgentFix = useCallback(
    (target: BugDetail) => void enqueueAgent(target),
    [enqueueAgent],
  );

  const handleLogout = () => {
    // No `window.confirm` here: WKWebView has no confirm panel delegate in the
    // Tauri window, so the callback always resolved to `false` and the button
    // appeared dead. Logging out is reversible (scan the QR again).
    void (async () => {
      try {
        await api.logout();
        setContext(null);
        setWorkspaceId("");
        closeDetail();
        setView("bugs");
        await refreshBase();
      } catch (error) {
        showToast("error", String(error));
      }
    })();
  };

  const openPath = useCallback(
    (path: string) => {
      void api.openPath(path).catch((error) => showToast("error", String(error)));
    },
    [showToast],
  );

  const openMedia = useCallback(
    async (url: string, mode: OpenMediaMode, kind?: string, target?: string) => {
      try {
        // Opening is self-evident (the app comes to the front); only failures
        // need a toast.
        await api.openMedia(url, mode, kind, target);
      } catch (error) {
        showToast("error", String(error));
      }
    },
    [showToast],
  );

  const copy = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        showToast("ok", "已复制");
      } catch (error) {
        showToast("error", `复制失败：${String(error)}`);
      }
    },
    [showToast],
  );

  const startSidebarResize = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarCollapsed ? 0 : effectiveSidebarWidth;
    setSidebarSized(true);
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
        setSidebarSized(false);
        setSidebarWidth(defaultSidebarWidth(viewportWidth));
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

  /** Drag the divider on the detail pane's left edge (like the sidebar). */
  const startDetailResize = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    let nextWidth = effectiveDetailWidth;
    setResizingDetail(true);

    const onMove = (move: MouseEvent) => {
      nextWidth = Math.max(
        DETAIL_MIN_WIDTH,
        Math.min(DETAIL_MAX_WIDTH, effectiveDetailWidth - (move.clientX - startX)),
      );
      setDetailWidth(nextWidth);
    };

    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setResizingDetail(false);
      // A wider pane may need a wider window; grow leftwards if necessary.
      const required =
        52 +
        effectiveSidebarWidth +
        DETAIL_CONTENT_MIN +
        nextWidth +
        LAYOUT_GUTTER;
      void api.ensureWindowWidth(required).catch(() => 0);
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
      : view === "projects"
        ? "项目管理"
        : view === "agent"
          ? "Agent"
          : view === "mcp"
            ? "MCP"
            : view === "account"
              ? "账户与会话"
              : "设置";
  const subtitle =
    view === "bugs"
      ? workspace
        ? `项目 ${workspace.id} · ${scope === "mine" ? "我负责的" : "全部缺陷"}`
        : "选择左侧项目开始"
      : view === "projects"
        ? "显示、本地文件夹与 Agent 规则"
        : view === "agent"
          ? "运行 opencode、审核权限与查看执行历史"
          : view === "mcp"
            ? "接入 AI 客户端与一键导入 opencode"
            : view === "account"
              ? ""
              : "通知与 AI 配置";

  return (
    <div
      className={clsx(
        "flex h-full flex-col overflow-hidden bg-[#f4f4f2] text-slate-900",
        (resizingSidebar || resizingDetail) && "select-none",
      )}
    >
      {/* macOS traffic lights live over this strip; the strip itself drags the
          window. The update button below has no drag attribute, so clicking it
          still opens the panel instead of moving the window. */}
      <div
        className="relative flex h-11 shrink-0 items-center gap-2 px-4"
        data-tauri-drag-region
      >
        <span className="ml-[62px] h-full flex-1" data-tauri-drag-region />
        {refreshing ? (
          <div className="pointer-events-none absolute inset-x-0 flex items-center justify-center gap-1.5 text-[11px] text-slate-400">
            <Loader2 size={12} className="animate-spin" />
            更新中
          </div>
        ) : null}

        {/* The update icon only exists while a newer release is known. */}
        {updateState?.available ? (
          <div className="group relative shrink-0">
            <button
              type="button"
              onClick={() => activateView("account")}
              title={`发现新版本 v${updateState.available.version}`}
              className="grid h-7 w-7 place-items-center rounded-lg text-emerald-600 transition hover:bg-emerald-50"
            >
              <span className="relative">
                <ArrowUpCircle size={16} />
                <span className="absolute -right-1 -top-1 h-1.5 w-1.5 rounded-full bg-emerald-500 ring-2 ring-[#f4f4f2]" />
              </span>
            </button>

            <div className="pointer-events-none invisible absolute right-0 top-9 z-50 w-80 translate-y-1 rounded-xl bg-slate-900/95 p-3 text-slate-200 opacity-0 shadow-2xl ring-1 ring-white/10 backdrop-blur-xl transition-all duration-150 group-hover:visible group-hover:translate-y-0 group-hover:opacity-100">
              <div className="flex items-center gap-2 text-[11px]">
                <ArrowUpCircle size={13} className="text-emerald-400" />
                <span className="font-semibold text-slate-100">
                  新版本 v{updateState.available.version}
                </span>
                <span className="ml-auto text-[10px] text-slate-400">更新日志</span>
              </div>
              <p className="mt-2 max-h-56 overflow-y-auto whitespace-pre-line text-[11px] leading-5 text-slate-300">
                {updateState.available.notes}
              </p>
              <p className="mt-2 border-t border-white/10 pt-2 text-[10px] text-slate-400">
                点击前往账户页更新
              </p>
            </div>
          </div>
        ) : null}
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
                onClick={() => activateView(item.id)}
                className={clsx(
                  "grid h-9 w-9 place-items-center rounded-xl transition",
                  view === item.id
                    ? "bg-black/[0.07] text-slate-900"
                    : "text-slate-500 hover:bg-black/[0.04] hover:text-slate-700",
                )}
              >
                <span
                  key={railAnim?.id === item.id ? railAnim.token : "idle"}
                  className={clsx(
                    "inline-flex items-center justify-center",
                    railAnim?.id === item.id && RAIL_ANIM[item.id],
                  )}
                >
                  {item.icon}
                </span>
              </button>
            ))}
          </div>
          <div className="flex-1" data-tauri-drag-region />
          {/* The user chip lives at the sidebar bottom; when the project list
              is collapsed it eases into the rail just above Settings. */}
          <div
            className={clsx(
              "grid h-9 w-9 place-items-center transition-all duration-300 ease-out",
              sidebarHidden
                ? "translate-y-0 scale-100 opacity-100"
                : "pointer-events-none translate-y-2 scale-75 opacity-0",
            )}
          >
            <button
              type="button"
              title="账户与会话"
              aria-label="账户与会话"
              onClick={() => activateView("account")}
              className="relative h-8 w-8 rounded-full transition hover:brightness-105"
            >
              <span
                key={railAnim?.id === "account" ? railAnim.token : "idle"}
                className={clsx(
                  "inline-flex items-center justify-center",
                  railAnim?.id === "account" && RAIL_ANIM.account,
                )}
              >
                <Avatar
                  src={info.meAvatar}
                  name={context?.user.nick || info.me}
                  className="h-8 w-8 text-[11px] shadow-sm ring-2 ring-white"
                />
              </span>
              <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-[#f4f4f2] bg-emerald-500" />
            </button>
          </div>
          <button
            type="button"
            title="设置"
            aria-label="设置"
            onClick={() => activateView("settings")}
            className={clsx(
              "grid h-9 w-9 place-items-center rounded-xl transition",
              view === "settings"
                ? "bg-black/[0.07] text-slate-900"
                : "text-slate-500 hover:bg-black/[0.04] hover:text-slate-700",
            )}
          >
            <span
              key={railAnim?.id === "settings" ? railAnim.token : "idle"}
              className={clsx(
                "inline-flex items-center justify-center",
                railAnim?.id === "settings" && RAIL_ANIM.settings,
              )}
            >
              <SettingsIcon size={15} />
            </span>
          </button>
        </div>

        {/* Project sidebar (resizable) */}
        <div
          className={clsx(
            "relative flex shrink-0 flex-col overflow-hidden",
            // Auto-collapse is instant: animating both the sidebar and the
            // detail pane reflows the bug table every frame.
            !resizingSidebar && !autoCollapseSidebar && "transition-[width] duration-200 ease-out",
          )}
          style={{ width: effectiveSidebarWidth }}
        >
          <div className="flex min-h-0 flex-1 flex-col px-2 pb-2">
            <div
              className="flex h-9 shrink-0 items-center justify-between pr-2"
              data-tauri-drag-region
            >
              <span className="min-w-0 flex-1 truncate px-2 text-[13px] font-semibold text-slate-800">
                项目
              </span>
              {visibleWorkspaces.length ? (
                <span className="shrink-0 text-[11px] tabular-nums text-slate-400">
                  {visibleWorkspaces.length}
                </span>
              ) : null}
            </div>

            <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto [scrollbar-gutter:stable]">
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
              <SkeletonRows
                rows={7}
                columns={["w-2/3", "w-6"]}
                className="pt-1"
                rowClassName="px-3 py-2.5"
                label="正在读取项目…"
              />
            ) : null}

            {context && visibleWorkspaces.length === 0 ? (
              <div className="rounded-lg border border-dashed border-slate-200 px-2.5 py-3 text-[11px] leading-5 text-slate-400">
                项目已全部隐藏，可在「项目」tab 中恢复显示。
              </div>
            ) : null}

            {visibleWorkspaces.map((item) => {
              const active = item.id === workspaceId;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => selectWorkspace(item.id)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setProjectMenu({
                      id: item.id,
                      name: item.name,
                      x: event.clientX,
                      y: event.clientY,
                    });
                  }}
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
                  <ScrollingName text={item.name} className="flex-1" />
                  {active ? (
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
                  ) : null}
                </button>
              );
            })}
            </div>
          </div>

          <button
            type="button"
            onClick={() => activateView("account")}
            title="账户与会话"
            className={clsx(
              "group flex w-full items-center gap-2.5 border-t border-black/[0.06] px-3 py-2.5 text-left transition",
              view === "account"
                ? "bg-black/[0.05]"
                : "hover:bg-black/[0.035]",
            )}
          >
            <span className="relative shrink-0">
              <Avatar
                src={info.meAvatar}
                name={context?.user.nick || info.me}
                className="h-7 w-7 text-[10px] shadow-sm"
              />
              <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-[#f4f4f2] bg-emerald-500" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12px] font-medium text-slate-700">
                {context?.user.nick || info.me || "已登录"}
              </span>
              <span className="block truncate text-[10px] text-slate-400">
                {context?.user.company || "账户与会话"}
              </span>
            </span>
            <ChevronRight
              size={13}
              className="shrink-0 text-slate-300 transition group-hover:text-slate-500"
            />
          </button>

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
            {!projectListHidden ? (
              <button
                type="button"
                aria-label={sidebarHidden ? "展开项目列表" : "收起项目列表"}
                title={
                  autoCollapseSidebar
                    ? sidebarPeek
                      ? "收起项目列表"
                      : "展开项目列表（窗口过窄，会自动收起）"
                    : sidebarHidden
                      ? "展开项目列表"
                      : "收起项目列表"
                }
                onClick={() => {
                  if (autoCollapseSidebar) setSidebarPeek((current) => !current);
                  else setSidebarCollapsed((current) => !current);
                }}
                className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-slate-400 transition hover:bg-black/[0.05] hover:text-slate-700"
              >
                {sidebarHidden ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
              </button>
            ) : null}

            <div className="min-w-0 flex-1 px-1">
              <h1 className="truncate text-[13px] font-semibold leading-5 text-slate-900">
                {title}
              </h1>
              {subtitle ? (
                <p className="truncate text-[11px] leading-4 text-slate-400">{subtitle}</p>
              ) : null}
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
                onOpenBug={openBug}
                onOpenWeb={openPath}
                onCopyLink={copy}
                onAgentFix={enqueueAgent}
                onClaim={claimBugFromList}
                refreshToken={refreshToken}
              />
            ) : (
              <div className="min-h-0 flex-1 p-4">
                <SkeletonRows
                  rows={10}
                  columns={["w-2/5", "w-16", "w-12", "w-16", "w-20", "w-16", "w-24"]}
                  label="正在加载项目…"
                />
              </div>
            )
          ) : view === "projects" ? (
            <div className="min-h-0 flex-1 overflow-y-auto p-5">
              <div className="mx-auto max-w-4xl">
                <ProjectSettings
                  context={context}
                  hiddenWorkspaceIds={hiddenWorkspaceIds}
                  onSetWorkspaceVisible={setWorkspaceVisible}
                  toast={showToast}
                />
              </div>
            </div>
          ) : view === "agent" ? (
            <AgentPage
              focusTaskId={agentFocusTaskId}
              onOpenBug={openBugById}
              toast={showToast}
            />
          ) : view === "mcp" ? (
            <div className="min-h-0 flex-1 overflow-y-auto p-5">
              <McpPage
                workspaces={context?.workspaces ?? []}
                onCopy={copy}
                toast={showToast}
              />
            </div>
          ) : view === "account" ? (
            <div className="min-h-0 flex-1 overflow-y-auto p-5">
              <AccountPage
                info={info}
                context={context}
                onShowLogin={() => {
                  void api
                    .sessionShow()
                    .catch((error) => showToast("error", String(error)));
                }}
                onLogout={handleLogout}
                onRefresh={() => {
                  void refreshBase();
                  void loadContext();
                }}
                toast={showToast}
              />
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto p-5">
              <SettingsPage
                info={info}
                onOpenPath={openPath}
                onCopy={(text) => void copy(text)}
                onShowOnboarding={() => {
                  void api
                    .resetOnboarding()
                    .then(() => refreshBase())
                    .catch((error) => showToast("error", String(error)));
                }}
                toast={showToast}
              />
            </div>
          )}
        </main>

        {/* Right detail pane (Codex-style): part of the layout, so the top
            drag strip stays reachable while it is open. */}
        {detailRendered ? (
          <div
            aria-hidden={!detailOpen}
            inert={!detailOpen}
            // Animate the pane's own width instead of sliding it in: the list
            // beside it shrinks in the same frames, so the shared edge moves as
            // one piece. The content is pinned to the right edge of the pane so
            // it is revealed rather than dragged across the screen.
            className={clsx(
              "relative flex h-full shrink-0 justify-end overflow-hidden",
              !resizingDetail && "transition-[width] duration-300 ease-out",
            )}
            style={{ width: detailOpen ? effectiveDetailWidth : 0 }}
          >
            <div
              className="flex h-full shrink-0 flex-col pb-2 pr-2"
              style={{ width: effectiveDetailWidth }}
            >
              <BugDetailDrawer
                open={detailOpen}
                detail={detail}
                loading={detailLoading}
                error={detailError}
                exporting={exporting}
                lastExport={lastExport}
                onClose={closeDetail}
                onOpenWeb={openPath}
                onCopy={copy}
                onExport={handleExport}
                onAgentFix={handleAgentFix}
                onOpenPath={openPath}
                onOpenMedia={openMedia}
                me={context?.user.nick ?? info.me}
                members={detailMembers}
                membersLoading={Boolean(
                  membersLoading[detail?.workspaceId ?? workspaceId],
                )}
                onRefreshMembers={refreshDetailMembers}
                onClaim={claimBugFromDetail}
                onAddComment={addBugComment}
                onChangeField={changeBugField}
                onTransition={transitionBug}
              />
            </div>

            {detailOpen ? (
              <button
                type="button"
                aria-label="调整详情面板宽度"
                title="拖动调整详情面板宽度"
                onMouseDown={startDetailResize}
                className={clsx(
                  "absolute left-0 top-0 z-10 h-full w-1.5 cursor-col-resize",
                  resizingDetail
                    ? "bg-sky-400/50"
                    : "bg-transparent transition hover:bg-black/[0.06]",
                )}
              />
            ) : null}
          </div>
        ) : null}
      </div>

      {pendingAgent ? (
        <FolderPicker
          open
          title="没有配置项目目录"
          description={`${
            pendingAgent.workspaceName || pendingAgent.workspaceId
          } 还没有设置本地仓库目录。选择后会自动加入 Agent 队列。`}
          confirmLabel="使用并继续"
          onCancel={() => setPendingAgent(null)}
          onSelect={(path) => void applyAgentFolder(pendingAgent, path)}
        />
      ) : null}

      {projectMenu ? (
        <div
          role="menu"
          className="fixed z-[70] min-w-[190px] rounded-lg border border-slate-200 bg-white p-1 text-[11px] text-slate-700 shadow-xl"
          style={{
            left: Math.min(projectMenu.x, window.innerWidth - 210),
            top: Math.min(projectMenu.y, window.innerHeight - 92),
          }}
          onPointerDown={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          <button
            type="button"
            onClick={() => hideWorkspace(projectMenu.id)}
            disabled={visibleWorkspaces.length <= 1}
            title={
              visibleWorkspaces.length <= 1 ? "至少保留一个项目" : "只影响本机显示"
            }
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
          >
            在本地隐藏「{projectMenu.name}」
          </button>
          <button
            type="button"
            onClick={() => {
              setProjectMenu(null);
              setView("projects");
            }}
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition hover:bg-slate-100"
          >
            管理项目
          </button>
        </div>
      ) : null}

      {!info.onboarded ? (
        <Onboarding info={info} onDone={() => void refreshBase()} />
      ) : null}

      {toastNode}
    </div>
  );
}
