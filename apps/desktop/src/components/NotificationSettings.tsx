import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { AlertTriangle, Bell, Clock, RefreshCw, Send } from "lucide-react";

import type { SettingsSectionProps } from "../lib/feature";
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  formatPollTime,
  notificationApi,
  type NotificationSettings as NotificationSettingsValue,
  type NotificationStateSnapshot,
} from "../lib/notification";
import { Badge, Button } from "./ui";

export function NotificationSettings({ toast }: SettingsSectionProps) {
  const [settings, setSettings] = useState<NotificationSettingsValue>(
    DEFAULT_NOTIFICATION_SETTINGS,
  );
  const [snapshot, setSnapshot] = useState<NotificationStateSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [simulating, setSimulating] = useState(false);

  const load = useCallback(
    async (silent = false) => {
      try {
        const state = await notificationApi.state();
        setSettings(state.settings);
        setSnapshot(state);
      } catch (error) {
        if (!silent) toast("error", String(error));
      } finally {
        setLoading(false);
      }
    },
    [toast],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  /** Applying a value persists it right away — there is no save button. */
  const persist = async (nextValue: NotificationSettingsValue) => {
    setSettings(nextValue);
    try {
      const result = await notificationApi.settingsSet(nextValue);
      setSettings(result.settings);
      await load(true);
    } catch (error) {
      toast("error", String(error));
    }
  };

  const patch = (partial: Partial<NotificationSettingsValue>) => {
    void persist({ ...settingsRef.current, ...partial });
  };

  const patchQuietHours = (partial: Partial<NotificationSettingsValue["quietHours"]>) => {
    const current = settingsRef.current;
    void persist({
      ...current,
      quietHours: { ...current.quietHours, ...partial },
    });
  };

  /** Text/number fields keep local state while typing and save on blur. */
  const saveOnBlur = () => {
    void persist(settingsRef.current);
  };

  const simulate = async () => {
    setSimulating(true);
    try {
      await notificationApi.simulate({});
      toast("ok", "已发送模拟通知，检查屏幕右下角");
    } catch (error) {
      toast("error", String(error));
    } finally {
      setSimulating(false);
    }
  };

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
            <Bell size={15} className="text-slate-400" />
            新缺陷通知
          </h2>
          <p className="mt-1 text-xs leading-5 text-slate-500">
            后台按轮询间隔检测新分配、转派与重新打开的缺陷，用自绘卡片提示，不依赖系统通知。
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {loading ? (
            <Badge tone="neutral">读取中</Badge>
          ) : snapshot?.running ? (
            <Badge tone="green">轮询中</Badge>
          ) : (
            <Badge tone="amber">已暂停</Badge>
          )}
        </div>
      </div>

      <div className="mt-4 space-y-3">
        <div className="flex items-center justify-between rounded-xl border border-slate-100 bg-slate-50/70 px-3 py-2.5">
          <div>
            <div className="text-xs font-medium text-slate-800">启用新缺陷通知</div>
            <div className="mt-0.5 text-[11px] text-slate-500">
              关闭后停止轮询与弹窗，已有待处理通知仍保留。
            </div>
          </div>
          <Toggle
            checked={settings.enabled}
            onChange={(value) => patch({ enabled: value })}
            label="启用新缺陷通知"
          />
        </div>

        <div>
          <div className="text-[11px] font-medium text-slate-600">通知范围</div>
          <div className="mt-1.5 grid gap-2 sm:grid-cols-2">
            <ScopeOption
              active={settings.scope === "mine"}
              title="只通知分配给我的"
              description="处理人等于当前 TAPD 用户"
              onClick={() => patch({ scope: "mine" })}
            />
            <ScopeOption
              active={settings.scope === "project"}
              title="项目内所有新缺陷"
              description="当前项目内的新分配与重开"
              onClick={() => patch({ scope: "project" })}
            />
          </div>
        </div>

        <div>
          <div className="text-[11px] font-medium text-slate-600">通知类型</div>
          <div className="mt-1.5 divide-y divide-slate-100 rounded-xl border border-slate-100">
            <SwitchRow
              label="纯新建"
              description="本轮新创建且分配给我的缺陷"
              checked={settings.includeNew}
              onChange={(value) => patch({ includeNew: value })}
            />
            <SwitchRow
              label="转派给我"
              description="非新建，但处理人刚刚变成我"
              checked={settings.includeTransferred}
              onChange={(value) => patch({ includeTransferred: value })}
            />
            <SwitchRow
              label="重新打开"
              description="状态从其它值变为重新打开"
              checked={settings.includeReopened}
              onChange={(value) => patch({ includeReopened: value })}
            />
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="rounded-xl border border-slate-100 bg-slate-50/70 px-3 py-2.5">
            <span className="flex items-center gap-1.5 text-[11px] font-medium text-slate-600">
              <RefreshCw size={11} className="text-slate-400" />
              轮询间隔（秒）
            </span>
            <input
              type="number"
              min={20}
              max={600}
              step={10}
              value={settings.pollIntervalSecs}
              onChange={(event) =>
                setSettings((current) => ({
                  ...current,
                  pollIntervalSecs: Number(event.target.value) || 60,
                }))
              }
              onBlur={saveOnBlur}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
              className="mt-1.5 w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700 focus:outline-none focus:ring-2 focus:ring-sky-200"
            />
            <span className="mt-1 block text-[10px] text-slate-400">允许 20–600 秒，默认 60。</span>
          </label>

          <label className="rounded-xl border border-slate-100 bg-slate-50/70 px-3 py-2.5">
            <span className="text-[11px] font-medium text-slate-600">同时展示数量</span>
            <select
              value={settings.maxVisible}
              onChange={(event) => patch({ maxVisible: Number(event.target.value) })}
              className="mt-1.5 w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700 focus:outline-none focus:ring-2 focus:ring-sky-200"
            >
              {[1, 2, 3, 4, 5].map((value) => (
                <option key={value} value={value}>
                  {value} 条
                </option>
              ))}
            </select>
            <span className="mt-1 block text-[10px] text-slate-400">
              超出部分保持待处理，处理一条后自动补位。
            </span>
          </label>
        </div>

        <div className="rounded-xl border border-slate-100 px-3 py-2.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-xs font-medium text-slate-800">
              <Clock size={12} className="text-slate-400" />
              免打扰
            </div>
            <Toggle
              checked={settings.quietHours.enabled}
              onChange={(value) => patchQuietHours({ enabled: value })}
              label="启用免打扰"
            />
          </div>
          <p className="mt-1 text-[11px] text-slate-500">
            时段内只累计待处理通知，不弹窗；时段结束后自动显示未处理通知。
          </p>
          <div className="mt-2 flex items-center gap-2">
            <input
              type="time"
              value={settings.quietHours.start}
              disabled={!settings.quietHours.enabled}
              onChange={(event) => patchQuietHours({ start: event.target.value })}
              className="rounded-lg border border-slate-200 px-2 py-1.5 text-xs text-slate-700 disabled:bg-slate-50 disabled:text-slate-400 focus:outline-none focus:ring-2 focus:ring-sky-200"
            />
            <span className="text-[11px] text-slate-400">至</span>
            <input
              type="time"
              value={settings.quietHours.end}
              disabled={!settings.quietHours.enabled}
              onChange={(event) => patchQuietHours({ end: event.target.value })}
              className="rounded-lg border border-slate-200 px-2 py-1.5 text-xs text-slate-700 disabled:bg-slate-50 disabled:text-slate-400 focus:outline-none focus:ring-2 focus:ring-sky-200"
            />
            <span className="text-[10px] text-slate-400">支持跨午夜（如 22:00–09:00）</span>
          </div>
        </div>

        <div className="rounded-xl border border-slate-100 bg-slate-50/70 px-3 py-2.5">
          <div className="grid gap-1 text-[11px] text-slate-500 sm:grid-cols-2">
            <div>
              上次轮询：
              <span className="ml-1 font-mono text-slate-700">
                {formatPollTime(snapshot?.lastPollAt ?? null)}
              </span>
            </div>
            <div className="min-w-0 truncate">
              待处理：
              <span className="ml-1 text-slate-700">
                {(snapshot?.items ?? []).filter((item) => item.state === "pending").length} 条
              </span>
            </div>
          </div>
          {snapshot?.lastError ? (
            <div className="mt-1.5 flex items-start gap-1.5 rounded-lg bg-rose-50 px-2 py-1.5 text-[10px] leading-4 text-rose-700">
              <AlertTriangle size={11} className="mt-0.5 shrink-0" />
              <span className="break-all">{snapshot.lastError}</span>
            </div>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            loading={simulating}
            onClick={() => void simulate()}
            icon={<Send size={13} />}
          >
            模拟通知
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void load()}
            icon={<RefreshCw size={13} />}
          >
            刷新状态
          </Button>
        </div>
      </div>
    </section>
  );
}

function ScopeOption(props: {
  active: boolean;
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={clsx(
        "rounded-xl border px-3 py-2 text-left transition",
        props.active
          ? "border-sky-300 bg-sky-50/60 shadow-sm"
          : "border-slate-200 bg-white hover:border-slate-300",
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={clsx(
            "grid h-3.5 w-3.5 place-items-center rounded-full border",
            props.active ? "border-sky-500" : "border-slate-300",
          )}
        >
          {props.active ? <span className="h-1.5 w-1.5 rounded-full bg-sky-500" /> : null}
        </span>
        <span className="text-xs font-medium text-slate-800">{props.title}</span>
      </div>
      <p className="mt-1 pl-5 text-[10px] leading-4 text-slate-500">{props.description}</p>
    </button>
  );
}

function SwitchRow(props: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2">
      <div>
        <div className="text-xs text-slate-700">{props.label}</div>
        <div className="text-[10px] text-slate-400">{props.description}</div>
      </div>
      <Toggle checked={props.checked} onChange={props.onChange} label={props.label} />
    </div>
  );
}

function Toggle(props: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      onClick={() => props.onChange(!props.checked)}
      className={clsx(
        "relative h-5 w-9 shrink-0 rounded-full transition focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-200",
        props.checked ? "bg-sky-500" : "bg-slate-300",
      )}
    >
      <span
        className={clsx(
          "absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition",
          props.checked ? "translate-x-4" : "translate-x-0",
        )}
      />
    </button>
  );
}
