import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { listen } from "@tauri-apps/api/event";
import clsx from "clsx";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Download,
  Eye,
  Info,
  Loader2,
  X,
} from "lucide-react";

import { agentApi, type AgentSummary } from "../lib/agent";
import { bugTitle } from "../lib/bug";
import {
  formatNotificationTime,
  NOTIFICATION_KIND_LABELS,
  notificationApi,
  onIslandLayout,
  onNotificationShow,
  pendingItems,
  type AiAction,
  type AiBlock,
  type AiPayload,
  type AiTone,
  type IslandLayout,
  type NotificationItem,
  type NotificationStateSnapshot,
} from "../lib/notification";
import {
  formatBytes,
  getUpdateSnapshot,
  startUpdateStore,
  subscribeUpdate,
  updateApi,
  updateOwnsScreen,
  type UpdateState,
} from "../lib/update";

const PILL_LAYOUT: IslandLayout = { expanded: false, width: 210, height: 34, count: 0 };

type Busy = { id: string; action: string } | null;

/**
 * Top-of-screen status capsule ("Dynamic Island"): collapsed it shows the
 * client's running state, expanded it morphs into the pending notification
 * cards. The window itself is transparent and chrome-less; the Rust side
 * animates the window size and tells us the layout via `island://layout`.
 */
export function IslandWindow() {
  const [layout, setLayout] = useState<IslandLayout>(PILL_LAYOUT);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [snapshot, setSnapshot] = useState<NotificationStateSnapshot | null>(null);
  const [agentSummary, setAgentSummary] = useState<AgentSummary | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  /** Update progress/error panel replaces the capsule while active. */
  const updateState = useSyncExternalStore(
    subscribeUpdate,
    getUpdateSnapshot,
    getUpdateSnapshot,
  );
  const updateActive = updateOwnsScreen(updateState?.phase);

  useEffect(() => {
    startUpdateStore();
  }, []);
  // Click vs double-click: a single click waits briefly so a double-click can
  // open the main window instead.
  const clickTimer = useRef<number | null>(null);
  const dragStart = useRef<{ x: number; y: number } | null>(null);

  // The island window is transparent: drop the app's light background and
  // scrollbars that only make sense in the main window.
  useEffect(() => {
    const previousBody = document.body.style.background;
    const previousHtml = document.documentElement.style.background;
    document.body.style.background = "transparent";
    document.documentElement.style.background = "transparent";
    return () => {
      document.body.style.background = previousBody;
      document.documentElement.style.background = previousHtml;
    };
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const next = await notificationApi.state();
      setSnapshot(next);
      setItems((current) =>
        current.length > 0 ? current : pendingItems(next.items).slice(0, Math.max(1, next.settings.maxVisible)),
      );
    } catch {
      // The Rust side owns the window; a failed status read is not fatal.
    }
  }, []);

  useEffect(() => {
    void refreshStatus();

    let unlistenShow: (() => void) | undefined;
    let unlistenLayout: (() => void) | undefined;
    let cancelled = false;

    void onNotificationShow(({ items: next }) => {
      if (cancelled) return;
      setItems(next);
      void refreshStatus();
    }).then((fn) => {
      if (cancelled) fn();
      else unlistenShow = fn;
    });

    void onIslandLayout((next) => {
      if (!cancelled) setLayout(next);
    }).then((fn) => {
      if (cancelled) fn();
      else unlistenLayout = fn;
    });

    // Keep the capsule honest even between polls; also self-heals if the
    // initial `island://layout` was emitted before the webview loaded.
    const timer = window.setInterval(() => {
      void refreshStatus();
      void agentApi
        .summary()
        .then((summary) => {
          if (!cancelled) setAgentSummary(summary);
        })
        .catch(() => undefined);
    }, 6000);

    return () => {
      cancelled = true;
      unlistenShow?.();
      unlistenLayout?.();
      window.clearInterval(timer);
      if (clickTimer.current !== null) window.clearTimeout(clickTimer.current);
    };
  }, [refreshStatus]);

  // Agent capsule state: initial snapshot plus live `agent://summary` pushes.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    void agentApi
      .summary()
      .then((summary) => {
        if (!cancelled) setAgentSummary(summary);
      })
      .catch(() => undefined);

    void listen<AgentSummary>("agent://summary", (event) => {
      if (!cancelled) setAgentSummary(event.payload);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Sync the window size with the pending list on first load.
  useEffect(() => {
    if (!snapshot) return;
    if (items.length > 0 && !layout.expanded) {
      void notificationApi.expandIsland(true).catch(() => undefined);
    }
  }, [snapshot, items.length, layout.expanded]);

  const run = async (item: NotificationItem, action: "handle" | "view" | "ignore") => {
    if (busy) return;
    setBusy({ id: item.id, action });
    setErrors((previous) => {
      const next = { ...previous };
      delete next[item.id];
      return next;
    });

    try {
      if (action === "handle") await notificationApi.handle(item.id);
      else if (action === "view") await notificationApi.view(item.id);
      else await notificationApi.ignore(item.id);
      setItems((previous) => previous.filter((candidate) => candidate.id !== item.id));
      void refreshStatus();
    } catch (error) {
      setErrors((previous) => ({ ...previous, [item.id]: String(error) }));
    } finally {
      setBusy(null);
    }
  };

  /** Reports an AI card's button click back to the waiting MCP call. */
  const runAi = async (item: NotificationItem, actionId: string) => {
    if (busy) return;
    setBusy({ id: item.id, action: `ai:${actionId}` });
    setErrors((previous) => {
      const next = { ...previous };
      delete next[item.id];
      return next;
    });

    try {
      await notificationApi.aiAction(item.id, actionId);
      setItems((previous) => previous.filter((candidate) => candidate.id !== item.id));
      void refreshStatus();
    } catch (error) {
      setErrors((previous) => ({ ...previous, [item.id]: String(error) }));
    } finally {
      setBusy(null);
    }
  };

  // Only treat the agent as clickable when there is actually something to show.
  const agentTaskId =
    agentSummary &&
    ((agentSummary.awaitingApproval ?? 0) > 0 || agentSummary.running)
      ? agentSummary.activeTaskId
      : null;

  const { label: statusLabel, tone } = useMemo(() => {
    if (updateState?.available) {
      return { label: `可更新 v${updateState.available.version}`, tone: "alert" as const };
    }
    if ((agentSummary?.awaitingApproval ?? 0) > 0) {
      return { label: "Agent 待审核", tone: "review" as const };
    }
    if (agentSummary?.running) return { label: "Agent 运行中", tone: "agent" as const };
    if (!snapshot) return { label: "连接中", tone: "idle" as const };
    if (!snapshot.running) return { label: "通知已暂停", tone: "paused" as const };
    if (snapshot.lastError) return { label: "同步异常", tone: "error" as const };
    if (items.length > 0) return { label: "待处理", tone: "alert" as const };
    return { label: "待命", tone: "ok" as const };
  }, [agentSummary, snapshot, items.length, updateState?.available]);

  if (updateActive) {
    return <UpdateCapsule state={updateState} />;
  }

  if (!layout.expanded) {
    return (
      <div className="grid h-full w-full place-items-center overflow-hidden">
        <button
          type="button"
          onMouseDown={(event) => {
            if (event.button === 0) dragStart.current = { x: event.clientX, y: event.clientY };
          }}
          onMouseMove={(event) => {
            const start = dragStart.current;
            if (!start) return;
            if (Math.hypot(event.clientX - start.x, event.clientY - start.y) < 4) return;
            dragStart.current = null;
            // Hand the drag to the window manager; the final position is
            // persisted by the Rust side once the drag settles.
            void notificationApi.startDrag().catch(() => undefined);
          }}
          onMouseUp={() => {
            dragStart.current = null;
          }}
          onClick={() => {
            if (clickTimer.current !== null) return;
            clickTimer.current = window.setTimeout(() => {
              clickTimer.current = null;
              if (agentTaskId) {
                void agentApi.openTask(agentTaskId).catch(() => undefined);
              } else if (items.length > 0) {
                void notificationApi.expandIsland(true);
              } else {
                void notificationApi.openMain();
              }
            }, 240);
          }}
          onDoubleClick={() => {
            if (clickTimer.current !== null) {
              window.clearTimeout(clickTimer.current);
              clickTimer.current = null;
            }
            void notificationApi.openMain();
          }}
          title={
            agentTaskId
              ? `${(agentSummary?.awaitingApproval ?? 0) > 0 ? "Agent 待审核" : "Agent 运行中"} · 单击打开任务 · 可拖动`
              : items.length > 0
                ? "单击展开通知 · 双击打开客户端 · 可拖动"
                : "双击打开客户端 · 可拖动"
          }
          className="island-pill group flex cursor-grab items-center gap-2 rounded-full bg-slate-900/90 px-3 py-1.5 text-ui-sm text-slate-200 border border-white/10 backdrop-blur-xl transition hover:bg-slate-900/95 active:cursor-grabbing"
        >
          <StatusDot tone={tone} />
          <span className="font-normal text-slate-100">TAPD</span>
          <span className="text-slate-400">{statusLabel}</span>
          {items.length > 0 ? (
            <span className="rounded-full bg-sky-500 px-1.5 py-0.5 text-ui-xs font-normal leading-none text-white">
              {items.length}
            </span>
          ) : null}
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col gap-1.5 overflow-hidden p-1.5">
      {items.length === 0 ? (
        <div className="island-expand grid flex-1 place-items-center rounded-2xl bg-slate-900/90 text-ui-sm text-slate-400 border border-white/10 backdrop-blur-xl">
          暂无待处理通知
        </div>
      ) : (
        items.map((item) => {
          const itemBusy = busy?.id === item.id ? busy.action : null;
          const error = errors[item.id];

          // AI / MCP cards use the generic payload and custom action buttons.
          if (item.source === "ai" && item.ai) {
            return (
              <AiCard
                key={item.id}
                item={item}
                payload={item.ai}
                busyAction={itemBusy}
                error={error}
                onAction={(actionId) => void runAi(item, actionId)}
                onDismiss={() => void run(item, "ignore")}
              />
            );
          }

          return (
            <article
              key={item.id}
              className="island-expand relative flex min-h-0 flex-1 flex-col rounded-2xl bg-slate-900/92 p-3 border border-white/10 backdrop-blur-xl"
            >
              <button
                type="button"
                aria-label="关闭（忽略）"
                title="关闭（忽略）"
                disabled={Boolean(busy)}
                onClick={() => void run(item, "ignore")}
                className="absolute right-2 top-2 grid h-6 w-6 place-items-center rounded-full text-slate-400 transition hover:bg-white/10 hover:text-white disabled:opacity-40"
              >
                {itemBusy === "ignore" ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <X size={13} />
                )}
              </button>

              <div className="flex items-center gap-1.5 pr-7 text-ui-xs text-slate-400">
                <span className="truncate font-normal text-slate-300">
                  {item.workspaceName}
                </span>
                <KindBadge kind={item.kind} />
                <span className="ml-auto shrink-0 tabular-nums">
                  {formatNotificationTime(item.created)}
                </span>
              </div>

              <h2
                className="mt-1 line-clamp-2 text-ui-base font-normal leading-5 text-slate-100"
                title={bugTitle(item.title)}
              >
                {bugTitle(item.title)}
              </h2>

              <div className="mt-1 flex items-center gap-1.5 text-ui-xs text-slate-400">
                {item.severity ? (
                  <span className="rounded bg-rose-500/15 px-1.5 py-0.5 text-rose-200">
                    {item.severity}
                  </span>
                ) : null}
                {item.priority ? (
                  <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-200">
                    {item.priority}优先级
                  </span>
                ) : null}
                <span className="min-w-0 flex-1 truncate text-right">
                  创建人 {item.creator || "—"}
                </span>
              </div>

              <div className="mt-auto flex items-center gap-1.5 pt-2">
                <button
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={() => void run(item, "handle")}
                  className="inline-flex flex-1 items-center justify-center gap-1 rounded-lg bg-sky-500 px-2.5 py-1.5 text-ui-sm font-normal text-white transition hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {itemBusy === "handle" ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Check size={12} />
                  )}
                  处理
                </button>
                <button
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={() => void run(item, "view")}
                  className="inline-flex flex-1 items-center justify-center gap-1 rounded-lg bg-white/5 px-2.5 py-1.5 text-ui-sm font-normal text-slate-200 border border-white/10 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {itemBusy === "view" ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Eye size={12} />
                  )}
                  查看
                </button>
              </div>

              {error ? (
                <p className="mt-1.5 line-clamp-2 text-ui-xs leading-4 text-rose-300" title={error}>
                  {error}
                </p>
              ) : null}
            </article>
          );
        })
      )}
    </div>
  );
}

const AI_TONE_META: Record<
  AiTone,
  {
    label: string;
    icon: typeof Info;
    iconBg: string;
    iconColor: string;
    badge: string;
  }
> = {
  info: {
    label: "提示",
    icon: Info,
    iconBg: "bg-sky-500/15",
    iconColor: "text-sky-300",
    badge: "bg-sky-400/15 text-sky-300",
  },
  success: {
    label: "成功",
    icon: CheckCircle2,
    iconBg: "bg-emerald-500/15",
    iconColor: "text-emerald-400",
    badge: "bg-emerald-400/15 text-emerald-300",
  },
  warning: {
    label: "警告",
    icon: AlertTriangle,
    iconBg: "bg-amber-500/15",
    iconColor: "text-amber-300",
    badge: "bg-amber-400/15 text-amber-300",
  },
  error: {
    label: "失败",
    icon: AlertTriangle,
    iconBg: "bg-rose-500/15",
    iconColor: "text-rose-300",
    badge: "bg-rose-400/15 text-rose-300",
  },
  progress: {
    label: "进行中",
    icon: Loader2,
    iconBg: "bg-sky-500/15",
    iconColor: "text-sky-300",
    badge: "bg-sky-400/15 text-sky-300",
  },
};

const AI_ACTION_CLASS: Record<string, string> = {
  primary: "bg-sky-500 text-white hover:bg-sky-400",
  secondary: "bg-white/5 text-slate-200 border border-white/10 hover:bg-white/10",
  danger: "bg-rose-500/90 text-white hover:bg-rose-400",
};

/** Generic card for AI / MCP notifications (tone + blocks + actions). */
function AiCard(props: {
  item: NotificationItem;
  payload: AiPayload;
  busyAction: string | null;
  error?: string;
  onAction: (actionId: string) => void;
  onDismiss: () => void;
}) {
  const { item, payload, busyAction, error, onAction, onDismiss } = props;
  const meta = AI_TONE_META[payload.tone] ?? AI_TONE_META.info;
  const Icon = meta.icon;
  const dismissBusy = busyAction === "ignore";

  return (
    <article className="island-expand relative flex min-h-0 flex-1 flex-col rounded-2xl bg-slate-900/92 p-3 border border-white/10 backdrop-blur-xl">
      <button
        type="button"
        aria-label="关闭"
        title="关闭"
        disabled={Boolean(busyAction)}
        onClick={onDismiss}
        className="absolute right-2 top-2 grid h-6 w-6 place-items-center rounded-full text-slate-400 transition hover:bg-white/10 hover:text-white disabled:opacity-40"
      >
        {dismissBusy ? <Loader2 size={12} className="animate-spin" /> : <X size={13} />}
      </button>

      <div className="flex items-center gap-1.5 pr-7 text-ui-xs text-slate-400">
        <span className={clsx("grid h-4 w-4 shrink-0 place-items-center rounded-full", meta.iconBg)}>
          <Icon
            size={11}
            className={clsx(meta.iconColor, payload.tone === "progress" && "animate-spin")}
          />
        </span>
        <span className="truncate font-normal text-slate-300" title={payload.client || item.workspaceName}>
          {payload.client || item.workspaceName || "AI"}
        </span>
        <span className={clsx("shrink-0 rounded px-1.5 py-0.5 text-ui-2xs font-normal", meta.badge)}>
          {meta.label}
        </span>
        <span className="ml-auto shrink-0 tabular-nums">
          {formatNotificationTime(item.created)}
        </span>
      </div>

      <h2
        className="mt-1 line-clamp-2 text-ui-base font-normal leading-5 text-slate-100"
        title={item.title}
      >
        {item.title}
      </h2>

      <AiBlocks blocks={payload.blocks} />

      <div className="mt-auto flex items-center gap-1.5 pt-2">
        {payload.actions.length === 0 ? (
          <button
            type="button"
            disabled={Boolean(busyAction)}
            onClick={onDismiss}
            className="inline-flex flex-1 items-center justify-center gap-1 rounded-lg bg-white/5 px-2.5 py-1.5 text-ui-sm font-normal text-slate-200 border border-white/10 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {dismissBusy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
            知道了
          </button>
        ) : (
          payload.actions.map((action) => (
            <AiActionButton
              key={action.id}
              action={action}
              busy={busyAction === `ai:${action.id}`}
              disabled={Boolean(busyAction)}
              onClick={() => onAction(action.id)}
            />
          ))
        )}
      </div>

      {error ? (
        <p className="mt-1.5 line-clamp-2 text-ui-xs leading-4 text-rose-300" title={error}>
          {error}
        </p>
      ) : null}
    </article>
  );
}

function AiActionButton(props: {
  action: AiAction;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const { action, busy, disabled, onClick } = props;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        "inline-flex flex-1 items-center justify-center gap-1 rounded-lg px-2.5 py-1.5 text-ui-sm font-normal transition disabled:cursor-not-allowed disabled:opacity-50",
        AI_ACTION_CLASS[action.style ?? "secondary"] ?? AI_ACTION_CLASS.secondary,
      )}
    >
      {busy ? <Loader2 size={12} className="animate-spin" /> : null}
      {action.label}
    </button>
  );
}

function AiBlocks({ blocks }: { blocks: AiBlock[] }) {
  if (blocks.length === 0) return null;

  return (
    <div className="mt-1 min-h-0 space-y-1 overflow-hidden">
      {blocks.map((block, index) => {
        switch (block.type) {
          case "text":
            return (
              <p
                key={index}
                className="line-clamp-2 whitespace-pre-wrap break-words text-ui-sm leading-4 text-slate-300"
              >
                {block.text}
              </p>
            );
          case "code":
            return (
              <pre
                key={index}
                className="line-clamp-2 overflow-hidden rounded bg-black/30 px-1.5 py-1 font-mono text-ui-xs leading-4 text-slate-200"
              >
                {block.text}
              </pre>
            );
          case "fields":
            return (
              <div key={index} className="space-y-0.5">
                {block.fields.map((field, fieldIndex) => (
                  <div
                    key={fieldIndex}
                    className="flex items-center justify-between gap-2 text-ui-xs leading-4"
                  >
                    <span className="shrink-0 text-slate-400">{field.label}</span>
                    <span className="min-w-0 truncate text-right text-slate-200" title={field.value}>
                      {field.value || "—"}
                    </span>
                  </div>
                ))}
              </div>
            );
          case "progress": {
            const percent = block.percent ?? 30;
            return (
              <div key={index} className="space-y-1">
                <div className="flex items-center justify-between text-ui-xs text-slate-400">
                  <span className="truncate">{block.label ?? "进度"}</span>
                  {block.percent != null ? (
                    <span className="ml-2 shrink-0 tabular-nums">
                      {Math.round(block.percent)}%
                    </span>
                  ) : null}
                </div>
                <div className="h-1 overflow-hidden rounded-full bg-white/10">
                  <div
                    className="h-full rounded-full bg-sky-400 transition-[width] duration-300"
                    style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
                  />
                </div>
              </div>
            );
          }
          case "divider":
            return <div key={index} className="h-px bg-white/10" />;
          default:
            return null;
        }
      })}
    </div>
  );
}

function StatusDot({
  tone,
}: {
  tone: "ok" | "alert" | "paused" | "error" | "idle" | "review" | "agent";
}) {
  return (
    <span className="relative grid h-2 w-2 shrink-0 place-items-center">
      <span
        className={clsx(
          "absolute h-full w-full rounded-full",
          tone === "ok" && "animate-ping bg-emerald-400/60",
          tone === "alert" && "animate-ping bg-sky-400/60",
          tone === "review" && "animate-ping bg-rose-400/60",
          tone === "agent" && "animate-ping bg-sky-400/60",
        )}
      />
      <span
        className={clsx(
          "h-2 w-2 rounded-full",
          tone === "ok" && "bg-emerald-400",
          tone === "alert" && "bg-sky-400",
          tone === "paused" && "bg-slate-400",
          tone === "error" && "bg-rose-400",
          tone === "idle" && "bg-amber-400",
          tone === "review" && "bg-rose-400",
          tone === "agent" && "bg-sky-400",
        )}
      />
    </span>
  );
}

/**
 * The 4x capsule shown while an update owns the screen. The Rust side sizes
 * the window to 840x136; the panel is intentionally compact enough to fit.
 */
function UpdateCapsule({ state }: { state: UpdateState | null }) {
  const phase = state?.phase ?? "idle";
  const progress = state?.progress;
  const failed = phase === "error";
  const target = state?.available?.version;
  const percent = progress?.percent;
  const [cancelling, setCancelling] = useState(false);

  const cancel = async () => {
    setCancelling(true);
    try {
      await updateApi.cancel();
    } catch {
      // The main window is restored by the Rust side; a failed call leaves
      // the error panel in place so the user can retry.
    } finally {
      setCancelling(false);
    }
  };

  const manual = () => {
    void updateApi.openManual().catch(() => undefined);
  };

  if (failed) {
    return (
      <div className="island-expand flex h-full w-full items-center gap-4 rounded-[30px] bg-slate-900/95 px-7 text-slate-100  border border-white/10 backdrop-blur-xl">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-rose-500/15 text-rose-400">
          <AlertTriangle size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-ui-base font-normal">更新失败</p>
          <p
            className="mt-0.5 truncate text-ui-sm text-slate-400"
            title={state?.error ?? undefined}
          >
            {state?.error ?? "下载或安装过程中出现错误。"}
          </p>
        </div>
        <button
          type="button"
          onClick={manual}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-white/10 px-4 py-2 text-ui-caption font-normal text-slate-100 border border-white/10 transition hover:bg-white/15"
        >
          <Download size={13} />
          手动下载
        </button>
        <button
          type="button"
          disabled={cancelling}
          onClick={() => void cancel()}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-white/5 px-4 py-2 text-ui-caption font-normal text-slate-300 border border-white/10 transition hover:bg-white/10 disabled:opacity-50"
        >
          {cancelling ? <Loader2 size={13} className="animate-spin" /> : <X size={13} />}
          取消
        </button>
      </div>
    );
  }

  const title =
    phase === "installing"
      ? "正在解包并安装"
      : phase === "ready"
        ? "更新完成"
        : "正在下载更新";
  const detail =
    phase === "downloading"
      ? `${percent != null ? `${percent.toFixed(0)}%` : "下载中"} · ${
          progress?.total
            ? `${formatBytes(progress.received)} / ${formatBytes(progress.total)}`
            : formatBytes(progress?.received)
        }`
      : phase === "ready"
        ? "应用即将重启…"
        : "校验更新包并写入应用目录…";

  return (
    <div className="island-expand flex h-full w-full flex-col justify-center gap-2.5 rounded-[30px] bg-slate-900/95 px-7 py-4 text-slate-100  border border-white/10 backdrop-blur-xl">
      <div className="flex items-center gap-2.5">
        {phase === "ready" ? (
          <CheckCircle2 size={17} className="text-emerald-400" />
        ) : (
          <Loader2 size={17} className="animate-spin text-sky-400" />
        )}
        <span className="text-ui-base font-normal tracking-wide">{title}</span>
        <span className="rounded-full bg-white/5 px-2 py-0.5 text-ui-xs text-slate-300">
          TAPD Client
        </span>
        <span className="font-mono text-ui-xs text-slate-400">
          v{state?.currentVersion ?? "—"}
          {target ? ` → v${target}` : ""}
        </span>
        <span className="ml-auto text-ui-sm tabular-nums text-slate-400">
          {phase === "downloading" && percent != null ? `${percent.toFixed(0)}%` : detail}
        </span>
      </div>

      <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
        <div
          className={clsx(
            "h-full rounded-full transition-[width] duration-200",
            phase === "ready" ? "bg-emerald-400" : "bg-sky-500",
            phase === "installing" && "w-full animate-pulse",
          )}
          style={{
            width:
              phase === "downloading" || phase === "ready"
                ? `${percent ?? 4}%`
                : "100%",
          }}
        />
      </div>

      <div className="flex items-center justify-between text-ui-xs text-slate-400">
        <span>{detail}</span>
        <span>更新期间主窗口不可打开</span>
      </div>
    </div>
  );
}

function KindBadge({ kind }: { kind: NotificationItem["kind"] }) {
  return (
    <span
      className={clsx(
        "shrink-0 rounded px-1.5 py-0.5 text-ui-2xs font-normal",
        kind === "new" && "bg-sky-400/15 text-sky-300",
        kind === "transferred" && "bg-violet-400/15 text-violet-300",
        kind === "reopened" && "bg-amber-400/15 text-amber-300",
        kind === "ai" && "bg-white/10 text-slate-300",
      )}
    >
      {NOTIFICATION_KIND_LABELS[kind]}
    </span>
  );
}
