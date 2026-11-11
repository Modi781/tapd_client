import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import {
  Bug,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Hash,
  ListFilter,
  Loader2,
  RefreshCw,
  Search,
  ShieldAlert,
  Sparkles,
  Type,
  UserPlus,
  UserRound,
  Users,
  WifiOff,
} from "lucide-react";
import clsx from "clsx";

import {
  api,
  type BugListPage,
  type BugQuery,
  type BugSummary,
  type Workspace,
} from "../lib/api";
import { isMyBug } from "../lib/bug";
import {
  agentBugKey,
  agentInFlightLabel,
  type AgentInFlight,
} from "../lib/agent";
import { cacheApi, type Cached } from "../lib/cache";
import { beginRefresh } from "../lib/refresh";
import { SkeletonRows } from "./Skeleton";
import {
  Badge,
  Button,
  EmptyState,
  PRIORITY_TONES,
  SEVERITY_TONES,
  STATUS_TONES,
} from "./ui";
import { Segmented } from "./Segmented";

const STATUS_ORDER = [
  "new",
  "in_progress",
  "resolved",
  "verified",
  "reopened",
  "rejected",
  "closed",
];

const PRIORITIES = [
  ["urgent", "紧急"],
  ["high", "高"],
  ["medium", "中"],
  ["low", "低"],
  ["insignificant", "无关紧要"],
];

const SEVERITIES = [
  ["fatal", "致命"],
  ["serious", "严重"],
  ["normal", "一般"],
  ["prompt", "提示"],
  ["advice", "建议"],
];

/**
 * Bug list auto-refresh cadence.
 *
 * Deliberately independent of the notification poll: that loop only emits
 * `data://refresh` when it produces a notification item, so edits, comments and
 * status changes (or a disabled notification toggle) left the table stale until
 * the user pressed 刷新.
 */
const AUTO_REFRESH_MS = 30_000;

/** Approximate row context menu box, used to keep it inside the window. */
const MENU_WIDTH = 168;
const MENU_HEIGHT = 100;

type Scope = "mine" | "all";

type Props = {
  workspace: Workspace | null;
  me: string | null;
  scope: Scope;
  onScopeChange: (scope: Scope) => void;
  onOpenBug: (bug: BugSummary) => void;
  /** Row actions (action column). */
  onOpenWeb?: (url: string) => void;
  /** Copy arbitrary text from the row context menu. */
  onCopy?: (text: string) => void;
  onAgentFix?: (bug: BugSummary) => void;
  /** Launch with a prompt/resources from the compose sheet. */
  onAgentCompose?: (bug: BugSummary) => void;
  /** In-flight agent tasks keyed by workspace + bug. */
  agentInFlight?: Map<string, AgentInFlight>;
  /** Jump to an already queued/running task instead of enqueuing again. */
  onOpenAgentTask?: (taskId: string) => void;
  /** Claim a bug owned by someone else, which unlocks its actions. */
  onClaim?: (bug: BugSummary) => Promise<void>;
  refreshToken: number;
};

function BugListViewImpl(props: Props) {
  const {
    workspace,
    me,
    scope,
    onScopeChange,
    onOpenBug,
    onOpenWeb,
    onCopy,
    onAgentFix,
    onAgentCompose,
    agentInFlight,
    onOpenAgentTask,
    onClaim,
    refreshToken,
  } = props;

  const [statusFilter, setStatusFilter] = useState<string[]>([]);
  const [priority, setPriority] = useState("");
  const [severity, setSeverity] = useState("");
  const [keyword, setKeyword] = useState("");
  const [debouncedKeyword, setDebouncedKeyword] = useState("");
  const [pageNo, setPageNo] = useState(1);
  const [page, setPage] = useState<BugListPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  /** Sync time (Unix seconds) of the cached snapshot currently on screen. */
  const [snapshotAt, setSnapshotAt] = useState<number | null>(null);
  /** Newest request wins; older responses (filters/page changed) are dropped. */
  const requestIdRef = useRef(0);
  /** Skips an auto-refresh tick while a request is already in flight. */
  const loadingRef = useRef(false);
  /** When the last request for the current query finished. */
  const lastLoadedAtRef = useRef(0);
  /** Bug id whose claim request is in flight. */
  const [claimingId, setClaimingId] = useState<string | null>(null);
  /** Right-click menu anchored at the pointer, on the row's bug. */
  const [rowMenu, setRowMenu] = useState<{ x: number; y: number; bug: BugSummary } | null>(
    null,
  );
  /** Menu entry that just copied, shown as "已复制" until the menu closes. */
  const [copiedKey, setCopiedKey] = useState<"id" | "title" | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const copiedTimerRef = useRef<number | null>(null);

  // Dismiss the row menu on any outside click, Escape, scroll, resize or blur.
  useEffect(() => {
    if (!rowMenu) return;

    const close = () => setRowMenu(null);
    const onPointerDown = (event: MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };

    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [rowMenu]);

  useEffect(
    () => () => {
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
    },
    [],
  );

  const openRowMenu = (event: ReactMouseEvent<HTMLTableRowElement>, bug: BugSummary) => {
    event.preventDefault();
    if (copiedTimerRef.current !== null) {
      window.clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = null;
    }
    setCopiedKey(null);
    setRowMenu({ x: event.clientX, y: event.clientY, bug });
  };

  const copyFromMenu = (key: "id" | "title", text: string) => {
    onCopy?.(text);
    setCopiedKey(key);
    if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = window.setTimeout(() => {
      copiedTimerRef.current = null;
      setCopiedKey(null);
      setRowMenu(null);
    }, 700);
  };

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedKeyword(keyword.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [keyword]);

  useEffect(() => {
    setPageNo(1);
  }, [scope]);

  const load = useCallback(async (silent = false) => {
    if (!workspace) return;

    const query: BugQuery = {
      workspaceId: workspace.id,
      owner: scope === "mine" ? me : null,
      statuses: statusFilter,
      priorities: priority ? [priority] : [],
      severities: severity ? [severity] : [],
      keyword: debouncedKeyword || null,
      modifiedAfter: null,
      createdAfter: null,
      sortName: "created",
      order: "desc",
      page: pageNo,
      perpage: 50,
      confId: null,
    };

    const requestId = ++requestIdRef.current;
    loadingRef.current = true;

    // Cache-first: paint the last snapshot for exactly this query before the
    // network round-trip, so a slow/offline TAPD never shows an empty table.
    // A background refresh already has a table on screen, so it skips this and
    // cannot flash an older snapshot over the current rows.
    let cached: Cached<BugListPage> | null = null;
    if (!silent) {
      try {
        cached = await cacheApi.bugList(query);
      } catch {
        // A cache read failure is not a page failure; the live request decides.
      }
      if (requestId !== requestIdRef.current) return;

      const snapshot = cached?.data ?? null;
      if (snapshot) {
        setPage(snapshot);
        setSnapshotAt(cached?.fetchedAt ?? null);
      }
    }

    if (!silent) {
      setError(null);
      setLoading(true);
    }
    // Background refreshes stay invisible: no table dimming and no global
    // "更新中" indicator every 30 seconds.
    const done = silent ? () => {} : beginRefresh();
    try {
      const result = await api.bugList(query);
      if (requestId !== requestIdRef.current) return;
      const lastPageNo = Math.max(
        1,
        Math.ceil(result.total / Math.max(1, result.perpage)),
      );
      if (pageNo > lastPageNo) {
        // The result set shrank while this tab was on a trailing page. Jump to
        // the new last page instead of rendering an empty table.
        setPageNo(lastPageNo);
        return;
      }
      setPage(result);
      setSnapshotAt(null);
      setError(null);
    } catch (cause) {
      if (requestId !== requestIdRef.current) return;
      if (silent) {
        // Keep the last good table; the next visible refresh surfaces failures.
      } else if (cached?.data) {
        // Offline: keep the cached table and let the inline notice explain it.
        setSnapshotAt(cached.fetchedAt ?? null);
      } else {
        setError(String(cause));
        setPage(null);
        setSnapshotAt(null);
      }
    } finally {
      done();
      if (requestId === requestIdRef.current) {
        loadingRef.current = false;
        lastLoadedAtRef.current = Date.now();
        if (!silent) setLoading(false);
      }
    }
  }, [workspace, scope, me, statusFilter, priority, severity, debouncedKeyword, pageNo]);

  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    void load();
  }, [load, reloadTick, refreshToken]);

  // Auto-refresh the visible list. Hidden windows pause; becoming visible
  // again catches up immediately when the snapshot is older than one interval.
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      if (loadingRef.current) return;
      if (Date.now() - lastLoadedAtRef.current < AUTO_REFRESH_MS) return;
      void loadRef.current(true);
    };
    const timer = window.setInterval(tick, AUTO_REFRESH_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, []);

  const statusEntries = getStatusEntries(page);
  const activeFilterCount =
    statusFilter.length + (priority ? 1 : 0) + (severity ? 1 : 0);
  const totalPages = page ? Math.max(1, Math.ceil(page.total / Math.max(1, page.perpage))) : 1;

  const toggleStatus = (key: string) => {
    setPageNo(1);
    setStatusFilter((current) =>
      current.includes(key)
        ? current.filter((item) => item !== key)
        : [...current, key],
    );
  };

  const clearFilters = () => {
    setPageNo(1);
    setStatusFilter([]);
    setPriority("");
    setSeverity("");
    setKeyword("");
  };

  const claim = async (bug: BugSummary) => {
    if (!onClaim || claimingId) return;
    setClaimingId(bug.id);
    try {
      await onClaim(bug);
    } catch {
      // App reports the failure; the row just returns to its claim button.
    } finally {
      setClaimingId(null);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-5 py-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-slate-900">缺陷</h2>
          {page ? (
            <span className="inline-flex w-[8ch] justify-center rounded-full bg-slate-100 px-1.5 py-0.5 text-[11px] tabular-nums text-slate-500">
              {page.total}
            </span>
          ) : null}
        </div>

        <Segmented
          value={scope}
          onChange={onScopeChange}
          options={[
            { value: "mine", label: "我负责的", icon: <UserRound size={12} /> },
            { value: "all", label: "全部", icon: <Users size={12} /> },
          ]}
        />

        {scope === "mine" && !me ? (
          <span className="text-[11px] text-amber-600">未能识别当前用户，暂按全部查询</span>
        ) : null}

        <div className="relative ml-auto w-64">
          <Search size={14} className="absolute left-3 top-2.5 text-slate-400" />
          <input
            value={keyword}
            onChange={(event) => {
              setPageNo(1);
              setKeyword(event.target.value);
            }}
            placeholder="搜索标题"
            className="w-full rounded-lg border border-slate-200 bg-slate-50 py-2 pl-9 pr-3 text-xs text-slate-800 outline-none transition focus:border-sky-400 focus:bg-white focus:ring-2 focus:ring-sky-100"
          />
        </div>

        <Button
          size="sm"
          variant="secondary"
          onClick={() => setReloadTick((tick) => tick + 1)}
          loading={loading}
          icon={<RefreshCw size={13} />}
        >
          刷新
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 bg-white px-5 py-2.5">
        <ListFilter size={13} className="text-slate-400" />
        <div className="flex flex-wrap items-center gap-1">
          {statusEntries.map(([key, label]) => {
            const active = statusFilter.includes(key);
            return (
              <button
                key={key}
                type="button"
                onClick={() => toggleStatus(key)}
                className={clsx(
                  "rounded-full border px-2.5 py-1 text-[11px] transition",
                  active
                    ? "border-sky-300 bg-sky-50 text-sky-700"
                    : "border-slate-200 bg-white text-slate-500 hover:border-slate-300 hover:text-slate-700",
                )}
              >
                {label}
              </button>
            );
          })}
        </div>

        <select
          value={priority}
          onChange={(event) => {
            setPageNo(1);
            setPriority(event.target.value);
          }}
          className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-600 outline-none"
        >
          <option value="">优先级</option>
          {PRIORITIES.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>

        <select
          value={severity}
          onChange={(event) => {
            setPageNo(1);
            setSeverity(event.target.value);
          }}
          className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-600 outline-none"
        >
          <option value="">严重程度</option>
          {SEVERITIES.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>

        {activeFilterCount > 0 ? (
          <button
            type="button"
            onClick={clearFilters}
            className="ml-1 text-[11px] text-slate-400 underline-offset-2 hover:text-slate-600 hover:underline"
          >
            清除筛选（{activeFilterCount}）
          </button>
        ) : null}
      </div>

      {page && snapshotAt !== null && !loading && !error ? (
        <div className="flex items-center gap-2 border-b border-amber-100 bg-amber-50/80 px-5 py-1.5 text-[11px] text-amber-700">
          <WifiOff size={12} className="shrink-0" />
          <span className="truncate">
            离线数据 · 上次同步 {formatSnapshotTime(snapshotAt)}
          </span>
          <button
            type="button"
            onClick={() => setReloadTick((tick) => tick + 1)}
            className="ml-auto inline-flex shrink-0 items-center gap-1 rounded border border-amber-200 bg-white px-1.5 py-0.5 text-[10px] text-amber-700 transition hover:bg-amber-100"
          >
            <RefreshCw size={10} />
            重试
          </button>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <div className="m-5 rounded-xl border border-rose-200 bg-rose-50 p-4 text-xs leading-6 text-rose-700">
            <div className="font-semibold">缺陷加载失败</div>
            <div className="mt-1 break-all">{error}</div>
            <div className="mt-3">
              <Button size="sm" onClick={() => setReloadTick((tick) => tick + 1)}>
                重试
              </Button>
            </div>
          </div>
        ) : null}

        {!error && !page && loading ? (
          <SkeletonRows
            className="pt-1"
            rows={9}
            columns={["w-[36%]", "w-12", "w-9", "w-14", "w-16", "w-12", "w-24"]}
            label="正在读取缺陷列表"
          />
        ) : null}

        {!error && page && page.bugs.length === 0 ? (
          <EmptyState
            icon={<Bug size={22} />}
            title={scope === "mine" ? "你名下没有符合条件的缺陷" : "没有符合条件的缺陷"}
            description={
              activeFilterCount > 0
                ? "试试清除部分筛选条件，或切换到「全部」。"
                : "当前项目的缺陷列表为空，或视图权限不足。"
            }
            action={
              activeFilterCount > 0 ? (
                <Button size="sm" onClick={clearFilters}>
                  清除筛选
                </Button>
              ) : null
            }
          />
        ) : null}

        {!error && page && page.bugs.length > 0 ? (
          <table className="w-full min-w-[1040px] border-separate border-spacing-0 text-left">
            <thead className="text-[11px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="sticky top-0 z-20 min-w-[320px] bg-slate-50 px-4 py-2.5 font-medium shadow-[0_-2px_0_0_var(--color-slate-50)]">
                  标题
                </th>
                <th className="sticky top-0 z-20 w-[92px] bg-slate-50 px-3 py-2.5 font-medium shadow-[0_-2px_0_0_var(--color-slate-50)]">
                  状态
                </th>
                <th className="sticky top-0 z-20 w-[76px] bg-slate-50 px-3 py-2.5 font-medium shadow-[0_-2px_0_0_var(--color-slate-50)]">
                  优先级
                </th>
                <th className="sticky top-0 z-20 w-[100px] bg-slate-50 px-3 py-2.5 font-medium shadow-[0_-2px_0_0_var(--color-slate-50)]">
                  严重程度
                </th>
                <th className="sticky top-0 z-20 w-[104px] bg-slate-50 px-3 py-2.5 font-medium shadow-[0_-2px_0_0_var(--color-slate-50)]">
                  处理人
                </th>
                <th className="sticky top-0 z-20 w-[88px] bg-slate-50 px-3 py-2.5 font-medium shadow-[0_-2px_0_0_var(--color-slate-50)]">
                  创建人
                </th>
                <th className="sticky top-0 z-20 w-[136px] bg-slate-50 px-4 py-2.5 font-medium shadow-[0_-2px_0_0_var(--color-slate-50)]">
                  创建时间
                </th>
                <th className="sticky top-0 right-0 z-30 w-[96px] border-l border-slate-200/70 bg-slate-50 px-2 py-2.5 text-right font-medium shadow-[0_-2px_0_0_var(--color-slate-50)]">
                  操作
                </th>
              </tr>
            </thead>
            <tbody
              className={clsx(
                "[&>tr+tr>td]:border-t [&>tr+tr>td]:border-slate-100",
                loading && "opacity-60",
              )}
            >
              {page.bugs.map((bug) => {
                const agent = agentInFlight?.get(
                  agentBugKey(bug.workspaceId, bug.id),
                );
                return (
                <tr
                  key={bug.id}
                  onClick={() => onOpenBug(bug)}
                  onContextMenu={(event) => openRowMenu(event, bug)}
                  className="group cursor-pointer bg-white text-xs transition hover:bg-sky-50"
                >
                  <td className="min-w-[320px] max-w-0 px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className="shrink-0 rounded bg-rose-50 px-1.5 py-0.5 text-[10px] font-bold text-rose-600">
                        BUG
                      </span>
                      <span
                        className="min-w-0 flex-1 truncate font-medium text-slate-800"
                        title={bug.title}
                      >
                        {bug.title}
                      </span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 overflow-hidden pl-9 text-[10px] text-slate-400">
                      <span className="shrink-0 font-mono">#{bug.shortId || bug.id.slice(-7)}</span>
                      {bug.versionReport ? (
                        <span className="shrink-0">发现版本 {bug.versionReport}</span>
                      ) : null}
                      {bug.iterationName ? <span className="truncate">{bug.iterationName}</span> : null}
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5">
                    <Badge tone={STATUS_TONES[bug.status] ?? "neutral"}>
                      {bug.statusLabel || bug.status}
                    </Badge>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5">
                    <Badge tone={PRIORITY_TONES[bug.priority] ?? "neutral"}>
                      {bug.priorityLabel || bug.priority || "—"}
                    </Badge>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5">
                    <Badge tone={SEVERITY_TONES[bug.severity] ?? "neutral"} dot>
                      {bug.severityLabel || bug.severity || "—"}
                    </Badge>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5">
                    <div className="flex items-center gap-1.5 text-slate-600">
                      <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-slate-100 text-[9px] font-medium text-slate-500">
                        {initials(bug.owner)}
                      </span>
                      <span className="truncate">{bug.owner || "—"}</span>
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-slate-500">
                    <span className="line-clamp-1">{bug.creator || "—"}</span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 font-mono text-[11px] text-slate-400">
                    {formatTs(bug.created)}
                  </td>
                  <td
                    className="sticky right-0 z-10 border-l border-slate-100 bg-white px-2 py-2.5 group-hover:bg-sky-50"
                    onClick={(event) => event.stopPropagation()}
                  >
                    {agent ? (
                      // Once queued, the only action is to inspect the task:
                      // other row actions are hidden so the bug cannot be
                      // enqueued or edited twice while the agent owns it.
                      <div className="flex items-center justify-end">
                        <button
                          type="button"
                          title="该缺陷已在 Agent 队列中，点击查看任务"
                          onClick={(event) => {
                            event.stopPropagation();
                            onOpenAgentTask?.(agent.task.id);
                          }}
                          className={clsx(
                            "inline-flex max-w-full items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium transition",
                            agent.task.status === "waiting_review" ||
                              agent.task.status === "awaiting_approval"
                              ? "border-amber-200 bg-amber-50 text-amber-700 hover:border-amber-300 hover:bg-amber-100"
                              : agent.task.status === "queued"
                                ? "border-slate-200 bg-slate-50 text-slate-600 hover:border-slate-300 hover:bg-slate-100"
                                : "border-sky-200 bg-sky-50 text-sky-700 hover:border-sky-300 hover:bg-sky-100",
                          )}
                        >
                          {agent.task.status === "queued" ? (
                            <Sparkles size={12} className="shrink-0" />
                          ) : agent.task.status === "waiting_review" ||
                            agent.task.status === "awaiting_approval" ? (
                            <ShieldAlert size={12} className="shrink-0" />
                          ) : (
                            <Loader2 size={12} className="shrink-0 animate-spin" />
                          )}
                          <span className="truncate">{agentInFlightLabel(agent)}</span>
                        </button>
                      </div>
                    ) : !isMyBug(bug.owner, me) ? (
                      <div className="flex items-center justify-center">
                        <button
                          type="button"
                          title="认领后可以评论、修改处理人/开发人员与流转状态"
                          disabled={claimingId !== null}
                          onClick={() => void claim(bug)}
                          className={clsx(
                            "inline-flex items-center justify-center gap-1 rounded-md border border-sky-200 bg-sky-50 px-3 py-1 text-[11px] font-medium text-sky-700 transition",
                            claimingId === null
                              ? "hover:border-sky-300 hover:bg-sky-100"
                              : "cursor-not-allowed opacity-60",
                          )}
                        >
                          {claimingId === bug.id ? (
                            <Loader2 size={12} className="animate-spin" />
                          ) : (
                            <UserPlus size={12} />
                          )}
                          {claimingId === bug.id ? "认领中" : "认领"}
                        </button>
                      </div>
                    ) : (
                      <AgentRowAction
                        onFix={() => onAgentFix?.(bug)}
                        onCompose={
                          onAgentCompose ? () => onAgentCompose(bug) : undefined
                        }
                      />
                    )}
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        ) : null}
      </div>

      {page && page.total > 0 ? (
        <div className="flex shrink-0 items-center justify-between border-t border-slate-200 bg-white px-5 py-2.5 text-[11px] text-slate-500">
          <span className="tabular-nums">
            共{" "}
            <span className="inline-block min-w-[6ch] text-right">{page.total}</span> 条 · 第{" "}
            {pageNo} / {totalPages} 页
          </span>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={pageNo <= 1 || loading}
              onClick={() => setPageNo((current) => Math.max(1, current - 1))}
              icon={<ChevronLeft size={13} />}
            >
              上一页
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={pageNo >= totalPages || loading}
              onClick={() => setPageNo((current) => Math.min(totalPages, current + 1))}
            >
              下一页
              <ChevronRight size={13} />
            </Button>
          </div>
        </div>
      ) : null}

      {rowMenu ? (
        <div
          ref={menuRef}
          role="menu"
          aria-label="缺陷快捷操作"
          style={{
            left: Math.max(8, Math.min(rowMenu.x, window.innerWidth - MENU_WIDTH - 8)),
            top: Math.max(8, Math.min(rowMenu.y, window.innerHeight - MENU_HEIGHT - 8)),
          }}
          className="fixed z-50 w-[168px] overflow-hidden rounded-lg border border-slate-200 bg-white py-1 shadow-xl"
          onContextMenu={(event) => event.preventDefault()}
        >
          <RowMenuItem
            icon={<Hash size={12} />}
            label={copiedKey === "id" ? "已复制 ID" : "复制 ID"}
            done={copiedKey === "id"}
            onClick={() => copyFromMenu("id", rowMenu.bug.shortId || rowMenu.bug.id)}
          />
          <RowMenuItem
            icon={<Type size={12} />}
            label={copiedKey === "title" ? "已复制标题" : "复制标题"}
            done={copiedKey === "title"}
            onClick={() => copyFromMenu("title", rowMenu.bug.title)}
          />
          {onOpenWeb ? (
            <RowMenuItem
              icon={<ExternalLink size={12} />}
              label="在 TAPD 中打开"
              onClick={() => {
                onOpenWeb(rowMenu.bug.bugUrl);
                setRowMenu(null);
              }}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Memoized so detail-pane state changes (open/loading/detail) do not reconcile
 * the whole bug table. Props must stay referentially stable: App passes
 * `useCallback` handlers and the workspace object from the loaded context.
 */
export const BugListView = memo(BugListViewImpl);

/**
 * Compact split action: the label launches the default prompt, the caret opens
 * the compose sheet for extra instructions or resources.
 */
function AgentRowAction(props: {
  onFix: () => void;
  onCompose?: () => void;
}) {
  return (
    <div className="flex items-center justify-end">
      <button
        type="button"
        title="用 Agent 修复"
        onClick={(event) => {
          event.stopPropagation();
          props.onFix();
        }}
        className="inline-flex h-6 items-center gap-1 rounded-l-md border border-slate-200 bg-white px-2 text-[11px] font-medium text-slate-600 transition hover:border-sky-300 hover:bg-sky-50 hover:text-sky-700"
      >
        <Sparkles size={12} />
        修复
      </button>
      {props.onCompose ? (
        <button
          type="button"
          title="添加补充说明或资源后启动"
          aria-label="添加补充说明或资源后启动"
          onClick={(event) => {
            event.stopPropagation();
            props.onCompose?.();
          }}
          className="grid h-6 w-6 place-items-center rounded-r-md border border-l-0 border-slate-200 bg-white text-slate-400 transition hover:border-sky-300 hover:bg-sky-50 hover:text-sky-700"
        >
          <ChevronDown size={12} />
        </button>
      ) : null}
    </div>
  );
}

function RowMenuItem(props: {
  label: string;
  icon: ReactNode;
  done?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={props.onClick}
      className={clsx(
        "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] transition",
        props.done
          ? "bg-emerald-50 text-emerald-700"
          : "text-slate-600 hover:bg-sky-50 hover:text-slate-900",
      )}
    >
      <span className={props.done ? "text-emerald-600" : "text-slate-400"}>{props.icon}</span>
      {props.label}
    </button>
  );
}

function getStatusEntries(page: BugListPage | null): Array<[string, string]> {
  const map = page?.statusMap;
  if (map && Object.keys(map).length > 0) {
    const known = STATUS_ORDER.filter((key) => map[key]).map(
      (key) => [key, map[key]] as [string, string],
    );
    if (known.length > 0) return known;
    return Object.entries(map).filter(
      ([key, label]) => !["start", "end"].includes(key) && typeof label === "string",
    );
  }

  return [
    ["new", "新"],
    ["in_progress", "接受/处理"],
    ["resolved", "已解决"],
    ["verified", "已验证"],
    ["reopened", "重新打开"],
  ];
}

function initials(name: string): string {
  if (!name) return "?";
  return name.length > 2 ? name.slice(-2) : name;
}

function formatTs(value: string): string {
  if (!value) return "—";
  return value.length >= 16 ? value.slice(0, 16) : value;
}

/** "上次同步" label: time only for today, date + time for older snapshots. */
function formatSnapshotTime(fetchedAt: number): string {
  const date = new Date(fetchedAt * 1000);
  if (Number.isNaN(date.getTime())) return "未知";

  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  const options: Intl.DateTimeFormatOptions = {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    ...(sameDay ? {} : { month: "2-digit", day: "2-digit" }),
  };
  return date.toLocaleString("zh-CN", options);
}
