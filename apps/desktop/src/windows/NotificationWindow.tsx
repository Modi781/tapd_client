import { useEffect, useState } from "react";
import clsx from "clsx";
import { BellRing, Check, Eye, Loader2, X } from "lucide-react";

import {
  formatNotificationTime,
  NOTIFICATION_KIND_LABELS,
  notificationApi,
  onNotificationShow,
  pendingItems,
  type NotificationItem,
} from "../lib/notification";

const CARD_BACKGROUND = "#0f1e31";
const WINDOW_BACKGROUND = "#0b1524";

type BusyAction = { id: string; action: "handle" | "view" | "ignore" } | null;

export function NotificationWindow() {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // The window is opaque: paint the card backdrop instead of a transparent window.
  useEffect(() => {
    const previousBody = document.body.style.background;
    const previousHtml = document.documentElement.style.background;
    document.body.style.background = WINDOW_BACKGROUND;
    document.documentElement.style.background = WINDOW_BACKGROUND;
    return () => {
      document.body.style.background = previousBody;
      document.documentElement.style.background = previousHtml;
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    void notificationApi
      .state()
      .then((snapshot) => {
        if (cancelled) return;
        setItems(
          pendingItems(snapshot.items).slice(0, Math.max(1, snapshot.settings.maxVisible)),
        );
      })
      .catch(() => {
        // The Rust side hides the window when there is nothing to show.
      });

    void onNotificationShow((next) => {
      if (!cancelled) setItems(next);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const run = async (item: NotificationItem, action: "handle" | "view" | "ignore") => {
    if (busy) return;
    setBusy({ id: item.id, action });
    setErrors((previous) => {
      const next = { ...previous };
      delete next[item.id];
      return next;
    });

    try {
      if (action === "handle") {
        await notificationApi.handle(item.id);
      } else if (action === "view") {
        await notificationApi.view(item.id);
      } else {
        await notificationApi.ignore(item.id);
      }
      setItems((previous) => previous.filter((candidate) => candidate.id !== item.id));
    } catch (error) {
      setErrors((previous) => ({ ...previous, [item.id]: String(error) }));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className="flex h-full flex-col gap-2 overflow-hidden p-2.5"
      style={{ background: WINDOW_BACKGROUND }}
    >
      {items.length === 0 ? (
        <div className="grid flex-1 place-items-center text-center text-[11px] leading-5 text-slate-400">
          <div>
            <BellRing size={18} className="mx-auto text-slate-500" />
            <p className="mt-1">暂无待处理通知</p>
          </div>
        </div>
      ) : (
        items.map((item) => {
          const itemBusy = busy?.id === item.id ? busy.action : null;
          const error = errors[item.id];

          return (
            <article
              key={item.id}
              className="flex min-h-0 flex-1 flex-col rounded-xl border border-white/10 p-3 shadow-lg shadow-black/30"
              style={{ background: CARD_BACKGROUND }}
            >
              <div className="flex items-center gap-1.5 text-[10px] text-slate-400">
                <span className="truncate font-medium text-slate-300">
                  {item.workspaceName}
                </span>
                <KindBadge kind={item.kind} />
                <span className="ml-auto shrink-0 tabular-nums">
                  {formatNotificationTime(item.created)}
                </span>
              </div>

              <h2
                className="mt-1 truncate text-[13px] font-semibold leading-5 text-slate-100"
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
                  className="inline-flex flex-1 items-center justify-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-[11px] font-medium text-slate-200 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {itemBusy === "view" ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Eye size={12} />
                  )}
                  查看
                </button>
                <button
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={() => void run(item, "ignore")}
                  className="inline-flex flex-1 items-center justify-center gap-1 rounded-lg border border-white/10 px-2.5 py-1.5 text-[11px] font-medium text-slate-400 transition hover:bg-white/5 hover:text-slate-200 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {itemBusy === "ignore" ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <X size={12} />
                  )}
                  忽略
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
