import clsx from "clsx";
import { Loader2 } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-primary text-primary-foreground  hover:bg-primary-hover disabled:bg-slate-200 disabled:text-slate-400",
  secondary:
    "border border-border bg-surface text-slate-700 hover:border-slate-300 hover:text-slate-900 disabled:text-slate-400",
  ghost:
    "text-slate-500 hover:bg-slate-100 hover:text-slate-800 disabled:opacity-40",
  danger:
    "border border-rose-200 bg-surface text-rose-600 hover:bg-rose-50 disabled:opacity-40",
};

export function Button(
  props: ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: ButtonVariant;
    size?: "sm" | "md";
    loading?: boolean;
    icon?: ReactNode;
  },
) {
  const {
    variant = "secondary",
    size = "md",
    loading = false,
    icon,
    className,
    children,
    disabled,
    ...rest
  } = props;

  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || loading}
      className={clsx(
        "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg font-normal transition focus-visible:outline-2 focus-visible:outline-sky-200 disabled:cursor-not-allowed",
        size === "sm" ? "px-2.5 py-1.5 text-ui-caption" : "px-3.5 py-2 text-ui-base",
        BUTTON_VARIANTS[variant],
        className,
      )}
    >
      {loading ? <Loader2 size={14} className="animate-spin" /> : icon}
      {children}
    </button>
  );
}

type BadgeTone =
  | "neutral"
  | "blue"
  | "green"
  | "amber"
  | "red"
  | "purple"
  | "cyan"
  | "slate";

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: "bg-slate-100 text-slate-600",
  slate: "bg-slate-800 text-slate-100",
  blue: "bg-sky-50 text-sky-700",
  green: "bg-emerald-50 text-emerald-700",
  amber: "bg-amber-50 text-amber-700",
  red: "bg-rose-50 text-rose-700",
  purple: "bg-violet-50 text-violet-700",
  cyan: "bg-cyan-50 text-cyan-700",
};

export function Badge(props: {
  tone?: BadgeTone;
  dot?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const { tone = "neutral", dot = false, children, className } = props;

  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-0.5 text-ui-sm font-normal",
        BADGE_TONES[tone],
        className,
      )}
    >
      {dot ? <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" /> : null}
      {children}
    </span>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 size={16} className={clsx("animate-spin text-slate-400", className)} />;
}

export function EmptyState(props: {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div
      className="grid min-h-[280px] place-items-center p-8 text-center"
      title={props.description}
    >
      <div className="max-w-md">
        <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-slate-100 text-slate-400">
          {props.icon}
        </div>
        <h3 className="mt-3 text-ui-base text-slate-800">{props.title}</h3>
        {props.action ? <div className="mt-4">{props.action}</div> : null}
      </div>
    </div>
  );
}

export const STATUS_TONES: Record<string, BadgeTone> = {
  new: "blue",
  in_progress: "amber",
  resolved: "green",
  verified: "cyan",
  reopened: "red",
  rejected: "neutral",
  closed: "neutral",
  open: "blue",
  progressing: "amber",
  done: "green",
};

export const PRIORITY_TONES: Record<string, BadgeTone> = {
  urgent: "red",
  high: "amber",
  medium: "blue",
  low: "neutral",
  insignificant: "neutral",
};

export const SEVERITY_TONES: Record<string, BadgeTone> = {
  fatal: "red",
  serious: "amber",
  normal: "blue",
  prompt: "neutral",
  advice: "neutral",
};
