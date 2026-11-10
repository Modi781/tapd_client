import { useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BellRing,
  Check,
  Loader2,
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

const STEPS = [
  {
    title: "登录与离线阅读",
    icon: <QrCode size={18} />,
    points: [
      "隐藏 WebView 持有 TAPD 会话，登录页直接显示企业微信二维码",
      "项目、缺陷列表与详情先读本地 SQLite 缓存，再后台刷新",
      "登录失效时会自动回到扫码页，不会弹出额外窗口",
    ],
  },
  {
    title: "把缺陷交给 AI",
    icon: <Sparkles size={18} />,
    points: [
      "MCP tab 提供查询、详情、导出、评论与状态回写，共 9 个工具",
      "可一键把 tapd-mcp 写入 opencode 全局配置，并设置读写策略",
      "Agent tab 负责修复队列、权限审核、执行历史与日志",
    ],
  },
  {
    title: "保持关注",
    icon: <BellRing size={18} />,
    points: [
      "顶部胶囊常驻显示通知与 Agent 状态，可拖动位置",
      "新缺陷、转派与重新打开可分别开关，并支持免打扰时段",
      "通知范围、项目和隐藏项目都在设置里管理",
    ],
  },
];

export function Onboarding({ info, onDone }: Props) {
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = STEPS[step];

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
    <div className="fixed inset-0 z-[90] grid place-items-center bg-slate-900/25 p-6 backdrop-blur-sm">
      <div className="w-full max-w-[560px] overflow-hidden rounded-3xl bg-white shadow-2xl ring-1 ring-black/5">
        <div className="relative overflow-hidden bg-gradient-to-br from-sky-50 via-white to-emerald-50 px-8 pb-6 pt-8">
          <div className="pointer-events-none absolute -right-16 -top-20 h-48 w-48 rounded-full bg-sky-200/50 blur-3xl" />
          <div className="pointer-events-none absolute -left-16 bottom-0 h-40 w-40 rounded-full bg-emerald-200/40 blur-3xl" />

          <div className="relative flex items-center gap-3">
            <div className="grid h-12 w-12 place-items-center rounded-2xl bg-white shadow-[0_10px_24px_-12px_rgba(2,132,199,0.55)] ring-1 ring-black/5">
              <img
                src={appIcon}
                alt="TAPD 客户端"
                draggable={false}
                className="h-10 w-10 select-none object-contain"
              />
            </div>
            <div>
              <div className="text-[10px] font-medium uppercase tracking-[0.18em] text-sky-600/70">
                Getting started · V{info.version}
              </div>
              <h2 className="mt-0.5 text-[20px] font-semibold tracking-tight text-slate-900">
                欢迎使用 TAPD 客户端
              </h2>
            </div>
          </div>
        </div>

        <div className="px-8 py-6">
          <div className="flex items-center gap-2 text-[13px] font-semibold text-slate-900">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-sky-50 text-sky-600">
              {current.icon}
            </span>
            {current.title}
          </div>
          <ul className="mt-4 space-y-2.5">
            {current.points.map((point) => (
              <li key={point} className="flex gap-2.5 text-[12px] leading-6 text-slate-600">
                <Check size={14} className="mt-1 shrink-0 text-emerald-500" />
                <span>{point}</span>
              </li>
            ))}
          </ul>
          {error ? (
            <div className="mt-4 rounded-xl bg-rose-50 px-3 py-2 text-[11px] text-rose-700 ring-1 ring-rose-100">
              {error}
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-slate-100 bg-slate-50/60 px-8 py-4">
          <button
            type="button"
            onClick={() => void finish()}
            disabled={busy}
            className="text-[11px] text-slate-400 transition hover:text-slate-600 disabled:opacity-40"
          >
            跳过引导
          </button>

          <div className="flex items-center gap-1.5">
            {STEPS.map((item, index) => (
              <button
                key={item.title}
                type="button"
                aria-label={`第 ${index + 1} 步`}
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
                onClick={() => setStep((value) => Math.max(0, value - 1))}
                disabled={busy}
                className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[11px] text-slate-500 transition hover:bg-white hover:text-slate-700 disabled:opacity-40"
              >
                <ArrowLeft size={12} />
                上一步
              </button>
            ) : null}
            {step < STEPS.length - 1 ? (
              <button
                type="button"
                onClick={() => setStep((value) => Math.min(STEPS.length - 1, value + 1))}
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
                {busy ? <Loader2 size={12} className="animate-spin" /> : <ShieldCheck size={12} />}
                开始使用
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
