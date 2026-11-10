import { useEffect, useState } from "react";
import { Bot, Terminal } from "lucide-react";

import { agentApi, type AgentConfig } from "../lib/agent";
import type { SettingsSectionProps } from "../lib/feature";
import { Badge, Button, Spinner } from "./ui";

const INPUT_CLASS =
  "w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700 outline-none transition placeholder:text-slate-300 focus:border-sky-300 focus:ring-2 focus:ring-sky-100";

const PROMPT_VARIABLES = [
  "{{title}}",
  "{{md_path}}",
  "{{repo_path}}",
  "{{workspace_name}}",
  "{{bug_id}}",
  "{{severity}}",
  "{{priority}}",
  "{{project_rule}}",
];

export function AgentSettings({ toast }: SettingsSectionProps) {
  const [config, setConfig] = useState<AgentConfig | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [detecting, setDetecting] = useState(false);

  useEffect(() => {
    void agentApi
      .configGet()
      .then(({ config: next }) => setConfig(next))
      .catch((error) => toast("error", String(error)));
  }, [toast]);

  const patchConfig = (patch: Partial<AgentConfig>) => {
    setConfig((current) => (current ? { ...current, ...patch } : current));
  };

  /** Persists the whole config; called on blur, there is no save button. */
  const commit = async (patch?: Partial<AgentConfig>) => {
    const base = config;
    if (!base) return;
    const next = { ...base, ...(patch ?? {}) };
    setConfig(next);
    try {
      const { config: saved } = await agentApi.configSet({
        binaryPath: next.binaryPath,
        promptTemplate: next.promptTemplate,
        readyQuietMs: finiteOr(next.readyQuietMs, 900),
        readyTimeoutMs: finiteOr(next.readyTimeoutMs, 15_000),
      });
      setConfig(saved);
    } catch (error) {
      toast("error", String(error));
    }
  };

  const handleDetect = async () => {
    setDetecting(true);
    try {
      const result = await agentApi.detect(config?.binaryPath);
      setVersion(result.version);
    } catch (error) {
      setVersion(null);
      toast("error", String(error));
    } finally {
      setDetecting(false);
    }
  };

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              <Bot size={15} className="text-slate-400" />
              Agent 修复
            </h2>
            <p className="mt-1 text-xs leading-5 text-slate-500">
              为缺陷创建 Agent 修复任务，按队列串行执行。
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              size="sm"
              onClick={() => void handleDetect()}
              loading={detecting}
              icon={<Terminal size={13} />}
            >
              检测版本
            </Button>
          </div>
        </div>

        {!config ? (
          <div className="mt-4 flex items-center gap-2 text-xs text-slate-400">
            <Spinner />
            读取 Agent 配置…
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            <div>
              <div className="flex items-center justify-between">
                <label className="text-[11px] font-medium text-slate-600">
                  opencode 可执行路径
                </label>
                {version ? (
                  <Badge tone="green">{version}</Badge>
                ) : null}
              </div>
              <input
                value={config.binaryPath}
                onChange={(event) => patchConfig({ binaryPath: event.target.value })}
                onBlur={() => void commit()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
                placeholder="opencode"
                className={`${INPUT_CLASS} mt-1.5 font-mono`}
              />
            </div>

            <div>
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-medium text-slate-600">
                  提示词模板
                </span>
                <span className="text-[10px] text-slate-400">
                  支持变量：{PROMPT_VARIABLES.join(" ")}
                </span>
              </div>
              <textarea
                value={config.promptTemplate}
                onChange={(event) =>
                  patchConfig({ promptTemplate: event.target.value })
                }
                onBlur={() => void commit()}
                rows={11}
                className={`${INPUT_CLASS} mt-1.5 resize-y leading-5`}
              />
              <div className="mt-1.5 flex flex-wrap gap-1">
                {PROMPT_VARIABLES.map((variable) => (
                  <span
                    key={variable}
                    className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-500"
                  >
                    {variable}
                  </span>
                ))}
              </div>
              <p className="mt-1.5 text-[10px] leading-4 text-slate-400">
                变量会替换为缺陷信息；<code className="rounded bg-slate-100 px-1 font-mono">{"{{project_rule}}"}</code> 来自项目设置。
              </p>
            </div>

            <details className="rounded-xl border border-slate-100 bg-slate-50/50">
              <summary className="cursor-pointer select-none px-3 py-2 text-[11px] text-slate-500">
                高级
              </summary>
              <div className="grid gap-3 p-3 pt-0 sm:grid-cols-2">
                <NumberField
                  label="就绪静默（ms）"
                  hint="输出静默达到该时长后注入任务"
                  value={config.readyQuietMs}
                  onChange={(value) => patchConfig({ readyQuietMs: value })}
                  onCommit={() => void commit()}
                />
                <NumberField
                  label="就绪超时（ms）"
                  hint="超时后强制注入"
                  value={config.readyTimeoutMs}
                  onChange={(value) => patchConfig({ readyTimeoutMs: value })}
                  onCommit={() => void commit()}
                />
              </div>
            </details>
          </div>
        )}
      </section>
    </div>
  );
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function NumberField(props: {
  label: string;
  hint: string;
  value: number;
  onChange: (value: number) => void;
  onCommit?: () => void;
}) {
  return (
    <div className="rounded-xl border border-slate-100 bg-slate-50/70 p-3">
      <div className="text-[10px] uppercase tracking-wide text-slate-400">
        {props.label}
      </div>
      <input
        type="number"
        min={0}
        value={Number.isFinite(props.value) ? props.value : ""}
        onChange={(event) => props.onChange(Number(event.target.value))}
        onBlur={props.onCommit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        className={`${INPUT_CLASS} mt-1.5 font-mono`}
      />
      <div className="mt-1 text-[10px] leading-4 text-slate-400">{props.hint}</div>
    </div>
  );
}
