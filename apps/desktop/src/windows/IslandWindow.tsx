import { useCallback, useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { Check, Eye, Loader2, X } from "lucide-react";

import {
  formatNotificationTime,
  NOTIFICATION_KIND_LABELS,
  notificationApi,
  onIslandLayout,
  onNotificationShow,
  pendingItems,
  type IslandLayout,
  type NotificationItem,
  type NotificationStateSnapshot,
} from "../lib/notification";

const PILL_LAYOUT: IslandLayout = { expanded: false, width: 210, height: 34, count: 0 };

type Busy = { id: string; action: "handle" | "view" | "ignore" } | null;

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
  const [busy, setBusy] = useState<Busy>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

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
    }, 6000);

    return () => {
      cancelled = true;
      unlistenShow?.();
      unlistenLayout?.();
      window.clearInterval(timer);
    };
  }, [refreshStatus]);

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

  const { label: statusLabel, tone } = useMemo(() => {
    if (!snapshot) return { label: "连接中", tone: "idle" as const };
    if (!snapshot.running) return { label: "通知已暂停", tone: "paused" as const };
    if (snapshot.lastError) return { label: "同步异常", tone: "error" as const };
    if (items.length > 0) return { label: "待处理", tone: "alert" as const };
    return { label: "运行中", tone: "ok" as const };
  }, [snapshot, items.length]);

  if (!layout.expanded) {
    return (
      <div className="grid h-full w-full place-items-center overflow-hidden">
        <button
          type="button"
          onClick={() => {
            if (items.length > 0) void notificationApi.expandIsland(true);
            else void notificationApi.openMain();
          }}
          title={items.length > 0 ? "展开通知" : "打开 TAPD 客户端"}
          className="island-pill group flex items-center gap-2 rounded-full bg-slate-900/90 px-3 py-1.5 text-[11px] text-slate-200 shadow-lg shadow-black/25 ring-1 ring-white/10 backdrop-blur-xl transition hover:bg-slate-900/95"
        >
          <StatusDot tone={tone} />
          <span className="font-semibold tracking-wide text-slate-100">TAPD</span>
          <span className="text-slate-400">{statusLabel}</span>
          {items.length > 0 ? (
            <span className="rounded-full bg-sky-500 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white">
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
        <div className="island-expand grid flex-1 place-items-center rounded-2xl bg-slate-900/90 text-[11px] text-slate-400 ring-1 ring-white/10 backdrop-blur-xl">
          暂无待处理通知
        </div>
      ) : (
        items.map((item) => {
          const itemBusy = busy?.id === item.id ? busy.action : null;
          const error = errors[item.id];

          return (
            <article
              key={item.id}
              className="island-expand relative flex min-h-0 flex-1 flex-col rounded-2xl bg-slate-900/92 p-3 shadow-2xl shadow-black/40 ring-1 ring-white/10 backdrop-blur-xl"
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

              <div className="flex items-center gap-1.5 pr-7 text-[10px] text-slate-400">
                <span className="truncate font-medium text-slate-300">
                  {item.workspaceName}
                </span>
                <KindBadge kind={item.kind} />
                <span className="ml-auto shrink-0 tabular-nums">
                  {formatNotificationTime(item.created)}
                </span>
              </div>

              <h2
                className="mt-1 line-clamp-2 text-[13px] font-semibold leading-5 text-slate-100"
                title={item.title}
              >
                {item.title}
              </h2>

              <div className="mt-1 flex items-center gap-1.5 text-[10px] text-slate-400">
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
                  className="inline-flex flex-1 items-center justify-center gap-1 rounded-lg bg-sky-500 px-2.5 py-1.5 text-[11px] font-medium text-white transition hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-50"
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
                  className="inline-flex flex-1 items-center justify-center gap-1 rounded-lg bg-white/5 px-2.5 py-1.5 text-[11px] font-medium text-slate-200 ring-1 ring-white/10 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
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
                <p className="mt-1.5 line-clamp-2 text-[10px] leading-4 text-rose-300" title={error}>
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

function StatusDot({ tone }: { tone: "ok" | "alert" | "paused" | "error" | "idle" }) {
  return (
    <span className="relative grid h-2 w-2 shrink-0 place-items-center">
      <span
        className={clsx(
          "absolute h-full w-full rounded-full",
          tone === "ok" && "animate-ping bg-emerald-400/60",
          tone === "alert" && "animate-ping bg-sky-400/60",
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
        )}
      />
    </span>
  );
}

function KindBadge({ kind }: { kind: NotificationItem["kind"] }) {
  return (
    <span
      className={clsx(
        "shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium",
        kind === "new" && "bg-sky-400/15 text-sky-300",
        kind === "transferred" && "bg-violet-400/15 text-violet-300",
        kind === "reopened" && "bg-amber-400/15 text-amber-300",
      )}
    >
      {NOTIFICATION_KIND_LABELS[kind]}
    </span>
  );
}
