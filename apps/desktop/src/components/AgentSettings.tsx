import { useState } from "react";
import { Terminal } from "lucide-react";

import { agentApi, type AgentConfig, type AgentRuntimeDescriptor } from "../lib/agent";
import type { SettingsSectionProps } from "../lib/feature";
import { Badge, Button } from "./ui";

const INPUT_CLASS =
  "w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700 outline-none transition placeholder:text-slate-300 focus:border-sky-300 focus:ring-2 focus:ring-sky-100";

const PROMPT_VARIABLES = [
  "{{title}}",
  "{{md_path}}",
  "{{repo_path}}",
  "{{workspace_name}}",
  "{{bug_id}}",
  "{{task_id}}",
  "{{severity}}",
  "{{priority}}",
  "{{project_rule}}",
];

type Props = {
  config: AgentConfig;
  runtime: AgentRuntimeDescriptor;
  onChange: (patch: Partial<AgentConfig>) => void;
  onCommit: (patch?: Partial<AgentConfig>) => void;
  toast: SettingsSectionProps["toast"];
};

/**
 * Runtime configuration form. Owned by the Agent management dialog: it edits
 * the selected runtime (binary path, prompt template, timing) and auto-saves
 * on blur.
 */
export function AgentSettings({ config, runtime, onChange, onCommit, toast }: Props) {
  const [version, setVersion] = useState<string | null>(null);
  const [detecting, setDetecting] = useState(false);

  const handleDetect = async () => {
    setDetecting(true);
    try {
      const result = await agentApi.detect(config.binaryPath || runtime.binary);
      setVersion(result.version);
    } catch (error) {
      setVersion(null);
      toast("error", String(error));
    } finally {
      setDetecting(false);
    }
  };

  return (
    <section>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-[12px] font-semibold text-slate-800">运行时配置</h3>
          <p className="mt-0.5 text-[11px] leading-5 text-slate-500">
            {runtime.name} · 修改后自动保存
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {version ? <Badge tone="green">{version}</Badge> : null}
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

      <div className="mt-3 space-y-4">
        <div>
          <label className="text-[11px] font-medium text-slate-600">
            {runtime.name} 可执行路径
          </label>
          <input
            value={config.binaryPath}
            onChange={(event) => onChange({ binaryPath: event.target.value })}
            onBlur={() => onCommit()}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
            placeholder={runtime.binary}
            className={`${INPUT_CLASS} mt-1.5 font-mono`}
          />
        </div>

        {runtime.transports.length > 1 ? (
          <div>
            <label className="text-[11px] font-medium text-slate-600">
              通信方式
            </label>
            <select
              value={config.transport}
              onChange={(event) => {
                const transport = event.target.value;
                onChange({ transport });
                onCommit({ transport });
              }}
              className={`${INPUT_CLASS} mt-1.5`}
            >
              {runtime.transports.map((transport) => (
                <option key={transport} value={transport}>
                  {transport === "acp"
                    ? "ACP 双向协议（无终端）"
                    : transport === "pty"
                      ? "PTY 交互终端"
                      : transport}
                </option>
              ))}
            </select>
            <p className="mt-1 text-[10px] leading-4 text-slate-400">
              ACP 使用结构化事件与权限选项；PTY 保留可交互的 TUI。
            </p>
          </div>
        ) : null}

        <div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[11px] font-medium text-slate-600">提示词模板</span>
            <span className="text-[10px] text-slate-400">
              支持变量：{PROMPT_VARIABLES.join(" ")}
            </span>
          </div>
          <textarea
            value={config.promptTemplate}
            onChange={(event) => onChange({ promptTemplate: event.target.value })}
            onBlur={() => onCommit()}
            rows={10}
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
            变量会替换为缺陷信息；
            <code className="rounded bg-slate-100 px-1 font-mono">
              {"{{project_rule}}"}
            </code>{" "}
            来自项目设置。
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
              onChange={(value) => onChange({ readyQuietMs: value })}
              onCommit={() => onCommit()}
            />
            <NumberField
              label="就绪超时（ms）"
              hint="超时后强制注入"
              value={config.readyTimeoutMs}
              onChange={(value) => onChange({ readyTimeoutMs: value })}
              onCommit={() => onCommit()}
            />
          </div>
        </details>
      </div>
    </section>
  );
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
