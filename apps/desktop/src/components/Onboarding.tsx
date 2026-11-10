import { useState, type ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Bell,
  Bot,
  Bug,
  FolderOpen,
  Loader2,
  Plug,
  QrCode,
  ShieldCheck,
  Sparkles,
} from "lucide-react";

import appIcon from "../assets/app-icon.png";
import { api, type AppInfo } from "../lib/api";

type Props = {
  info: AppInfo;
  onDone: () => void;
};

/* --------------------------------------------------------------------------
 * Tiny fake product shots. They are plain DOM/SVG so they stay crisp without
 * shipping extra screenshots.
 * ----------------------------------------------------------------------- */

function NotificationArt() {
  return (
    <div className="relative h-[108px] overflow-hidden rounded-xl bg-gradient-to-br from-slate-100 via-sky-50 to-white p-3">
      <div className="absolute right-3 top-3 flex h-5 items-center gap-1 rounded-full bg-slate-900 px-2 text-[7px] text-slate-200 shadow-sm">
        <span className="h-1 w-1 rounded-full bg-emerald-400" />
        TAPD 待命
      </div>
      <div className="mt-7 w-[82%] rounded-lg bg-slate-900 p-2 shadow-lg shadow-slate-900/15">
        <div className="flex items-center gap-1">
          <span className="grid h-4 w-4 place-items-center rounded bg-sky-500 text-white">
            <Bug size={9} />
          </span>
          <span className="h-1 w-10 rounded bg-white/25" />
          <span className="ml-auto h-1 w-4 rounded bg-white/10" />
        </div>
        <div className="mt-1.5 h-1 w-full rounded bg-white/30" />
        <div className="mt-1 h-1 w-3/4 rounded bg-white/15" />
        <div className="mt-2 flex gap-1">
          <span className="h-3 flex-1 rounded bg-sky-500" />
          <span className="h-3 flex-1 rounded bg-white/10" />
        </div>
      </div>
      <span className="absolute right-5 top-12 h-2 w-2 rounded-full bg-rose-500 ring-2 ring-white" />
      <Bell size={13} className="absolute bottom-3 right-4 text-slate-300" />
    </div>
  );
}

function FocusArt() {
  return (
    <div className="h-[108px] overflow-hidden rounded-xl bg-gradient-to-br from-emerald-50 via-white to-sky-50 p-2.5">
      <div className="flex h-full gap-1.5 rounded-lg bg-white p-1.5 shadow-sm ring-1 ring-slate-200/70">
        <div className="flex w-6 flex-col items-center gap-1 rounded-md bg-slate-50 py-1">
          <span className="h-2 w-2 rounded bg-sky-400" />
          <span className="h-2 w-2 rounded bg-slate-200" />
          <span className="h-2 w-2 rounded bg-slate-200" />
          <span className="mt-auto h-3 w-3 rounded-full bg-gradient-to-br from-sky-400 to-emerald-400" />
        </div>
        <div className="flex w-[74px] flex-col gap-1">
          <span className="h-1 w-8 rounded bg-slate-300" />
          <span className="mt-0.5 h-3.5 w-full rounded bg-sky-50 ring-1 ring-sky-200" />
          <span className="h-3.5 w-full rounded bg-slate-50" />
          <span className="h-3.5 w-full rounded bg-slate-50" />
          <span className="h-3.5 w-4/5 rounded bg-slate-50" />
        </div>
        <div className="flex flex-1 flex-col gap-1 rounded-md bg-slate-50 p-1.5">
          <span className="h-1 w-9 rounded bg-slate-300" />
          <span className="h-1 w-full rounded bg-slate-200" />
          <span className="h-1 w-5/6 rounded bg-slate-200" />
          <span className="mt-auto h-3 w-10 rounded bg-slate-900/80" />
        </div>
      </div>
    </div>
  );
}

function FixArt() {
  return (
    <div className="relative h-[108px] overflow-hidden rounded-xl bg-gradient-to-br from-sky-50 via-white to-violet-50">
      <div className="absolute left-3 top-1/2 grid h-12 w-12 -translate-y-1/2 place-items-center rounded-2xl bg-white shadow-sm ring-1 ring-slate-200">
        <div className="relative">
          <Bot size={26} className="text-slate-800" strokeWidth={1.8} />
          <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-emerald-400" />
        </div>
      </div>
      <div className="absolute right-3 top-1/2 w-28 -translate-y-1/2 rounded-lg bg-slate-900 p-2 shadow-lg shadow-slate-900/15">
        <div className="h-1 w-10 rounded bg-white/30" />
        <div className="mt-1 h-1 w-16 rounded bg-white/15" />
        <div className="mt-2 inline-flex h-4 items-center gap-1 rounded bg-emerald-400 px-1.5 text-[6px] font-semibold text-slate-900">
          <Sparkles size={7} />
          自动修复
        </div>
      </div>
    </div>
  );
}

function McpArt() {
  return (
    <div className="relative h-[108px] overflow-hidden rounded-xl bg-gradient-to-br from-slate-900 to-slate-800 p-3 text-slate-200">
      <span className="absolute left-3 top-2.5 rounded bg-white/5 px-1.5 py-1 font-mono text-[7px] text-slate-300">
        {"{ }"}
      </span>
      <span className="absolute bottom-2.5 left-3 rounded bg-white/5 px-1.5 py-1 font-mono text-[7px] text-slate-300">
        {"</>"}
      </span>
      <span className="absolute right-3 top-2.5 rounded bg-white/5 px-1.5 py-1 font-mono text-[7px] text-slate-300">
        AI
      </span>
      <span className="absolute left-1/2 top-1/2 grid h-9 w-9 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-xl bg-sky-500 text-white shadow-lg shadow-sky-500/30">
        <Plug size={16} />
      </span>
      <svg
        className="absolute inset-0 h-full w-full"
        viewBox="0 0 180 108"
        fill="none"
        aria-hidden="true"
      >
        <path d="M25 25 L78 48" stroke="rgba(56,189,248,.35)" strokeWidth="1" />
        <path d="M25 84 L78 62" stroke="rgba(56,189,248,.25)" strokeWidth="1" />
        <path d="M155 25 L104 48" stroke="rgba(52,211,153,.3)" strokeWidth="1" />
      </svg>
    </div>
  );
}

const FEATURES: Array<{
  title: string;
  copy: string;
  art: ReactNode;
}> = [
  {
    title: "新 bug 通知",
    copy: "新缺陷、转派、重开，胶囊立刻提醒。",
    art: <NotificationArt />,
  },
  {
    title: "专注工作",
    copy: "列表、详情、筛选，一个窗口搞定。",
    art: <FocusArt />,
  },
  {
    title: "一键修复",
    copy: "交给 Agent，修完自动回写 TAPD。",
    art: <FixArt />,
  },
  {
    title: "MCP 给外部",
    copy: "opencode / Claude / Cursor 直接接入。",
    art: <McpArt />,
  },
];

const QUICK_START = [
  {
    icon: <QrCode size={18} />,
    title: "扫码登录",
    hint: "企业微信扫一扫",
  },
  {
    icon: <FolderOpen size={18} />,
    title: "选择项目",
    hint: "从左侧项目栏开始",
  },
  {
    icon: <Plug size={18} />,
    title: "按需接入",
    hint: "MCP / Agent tab",
  },
];

export function Onboarding({ info, onDone }: Props) {
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const finish = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.completeOnboarding();
      onDone();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[90] grid place-items-center bg-slate-900/30 p-4 backdrop-blur-sm">
      <div className="max-h-[calc(100vh-2rem)] w-full max-w-[720px] overflow-y-auto rounded-3xl bg-white shadow-2xl ring-1 ring-black/5">
        <div className="relative overflow-hidden bg-gradient-to-br from-sky-50 via-white to-emerald-50 px-7 pb-6 pt-7">
          <div className="pointer-events-none absolute -right-20 -top-24 h-56 w-56 rounded-full bg-sky-200/50 blur-3xl" />
          <div className="pointer-events-none absolute -left-20 bottom-0 h-44 w-44 rounded-full bg-emerald-200/40 blur-3xl" />

          <div className="relative flex items-center gap-3">
            <div className="grid h-11 w-11 place-items-center rounded-2xl bg-white shadow-[0_10px_24px_-12px_rgba(2,132,199,0.55)] ring-1 ring-black/5">
              <img
                src={appIcon}
                alt="TAPD 客户端"
                draggable={false}
                className="h-9 w-9 select-none object-contain"
              />
            </div>
            <div className="min-w-0">
              <div className="text-[10px] font-medium uppercase tracking-[0.18em] text-sky-600/70">
                TAPD Client · V{info.version}
              </div>
              <h2 className="mt-0.5 text-[21px] font-semibold tracking-tight text-slate-900">
                {step === 0 ? "把 TAPD 变成工作台" : "一分钟开始使用"}
              </h2>
              <p className="mt-0.5 text-[11px] text-slate-500">
                {step === 0 ? "四个每天都会用到的能力" : "扫码、选项目，然后开工"}
              </p>
            </div>
          </div>
        </div>

        <div className="flex min-h-[380px] flex-col justify-center px-7 py-5">
          {step === 0 ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {FEATURES.map((feature) => (
                <div
                  key={feature.title}
                  className="rounded-2xl border border-slate-100 bg-white p-3 transition hover:border-slate-200 hover:shadow-sm"
                >
                  {feature.art}
                  <div className="mt-3 text-[13px] font-semibold text-slate-900">
                    {feature.title}
                  </div>
                  <div className="mt-0.5 text-[11px] leading-5 text-slate-500">
                    {feature.copy}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-3">
              {QUICK_START.map((item, index) => (
                <div
                  key={item.title}
                  className="relative rounded-2xl border border-slate-100 bg-slate-50/70 p-4"
                >
                  <span className="absolute right-3 top-3 text-[10px] font-medium text-slate-300">
                    0{index + 1}
                  </span>
                  <span className="grid h-8 w-8 place-items-center rounded-lg bg-white text-sky-500 shadow-sm ring-1 ring-slate-100">
                    {item.icon}
                  </span>
                  <div className="mt-3 text-[13px] font-semibold text-slate-900">
                    {item.title}
                  </div>
                  <div className="mt-0.5 text-[11px] text-slate-500">{item.hint}</div>
                </div>
              ))}
            </div>
          )}

          {error ? (
            <div className="mt-4 rounded-xl bg-rose-50 px-3 py-2 text-[11px] text-rose-700 ring-1 ring-rose-100">
              {error}
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-slate-100 bg-slate-50/60 px-7 py-4">
          <button
            type="button"
            onClick={() => void finish()}
            disabled={busy}
            className="text-[11px] text-slate-400 transition hover:text-slate-600 disabled:opacity-40"
          >
            跳过
          </button>

          <div className="flex items-center gap-1.5">
            {[0, 1].map((index) => (
              <button
                key={index}
                type="button"
                aria-label={`第 ${index + 1} 页`}
                onClick={() => setStep(index)}
                className={
                  index === step
                    ? "h-1.5 w-5 rounded-full bg-sky-500 transition-all"
                    : "h-1.5 w-1.5 rounded-full bg-slate-300 transition-all hover:bg-slate-400"
                }
              />
            ))}
          </div>

          <div className="flex items-center gap-2">
            {step > 0 ? (
              <button
                type="button"
                onClick={() => setStep(0)}
                disabled={busy}
                className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[11px] text-slate-500 transition hover:bg-white hover:text-slate-700 disabled:opacity-40"
              >
                <ArrowLeft size={12} />
                回看卖点
              </button>
            ) : null}
            {step === 0 ? (
              <button
                type="button"
                onClick={() => setStep(1)}
                className="inline-flex items-center gap-1 rounded-lg bg-slate-900 px-3 py-1.5 text-[11px] font-medium text-white transition hover:bg-slate-800"
              >
                下一步
                <ArrowRight size={12} />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void finish()}
                disabled={busy}
                className="inline-flex items-center gap-1 rounded-lg bg-sky-500 px-3 py-1.5 text-[11px] font-medium text-white transition hover:bg-sky-400 disabled:opacity-60"
              >
                {busy ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <ShieldCheck size={12} />
                )}
                开始使用
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
