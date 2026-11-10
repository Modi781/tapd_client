import { useCallback, useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";

import "@xterm/xterm/css/xterm.css";

import { agentApi, type AgentOutputPayload } from "../lib/agent";

type Props = {
  /** Task whose PTY is attached; `null` shows an idle terminal. */
  taskId: string | null;
};

/**
 * Embeddable opencode terminal. The xterm instance is created once and reused;
 * switching `taskId` resets the screen, replays the task's log tail and forwards
 * subsequent `agent://output` chunks for that task.
 */
export function AgentTerminal({ taskId }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const taskIdRef = useRef<string | null>(taskId);

  const syncSize = useCallback(() => {
    const term = terminalRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    try {
      fit.fit();
    } catch {
      /* the container can be zero-sized while the tab is hidden */
    }
    const id = taskIdRef.current;
    if (id && term.cols > 0 && term.rows > 0) {
      void agentApi.resize(id, term.cols, term.rows).catch(() => {
        /* resizing a task that has already exited is harmless */
      });
    }
  }, []);

  // Create the terminal once for the lifetime of this embedded view.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
      fontSize: 12,
      lineHeight: 1.25,
      scrollback: 10_000,
      theme: {
        background: "#09090b",
        foreground: "#e4e4e7",
        cursor: "#38bdf8",
        selectionBackground: "#334155",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    terminalRef.current = term;
    fitRef.current = fit;

    const inputDisposable = term.onData((data) => {
      const id = taskIdRef.current;
      if (!id) return;
      void agentApi.input(id, data).catch(() => {
        /* typing while no PTY is attached is harmless */
      });
    });

    let disposed = false;
    let unlisten: (() => void) | undefined;

    void listen<AgentOutputPayload>("agent://output", (event) => {
      const { taskId: id, data } = event.payload;
      if (!data || id !== taskIdRef.current) return;
      term.write(data);
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });

    const onWindowResize = () => syncSize();
    window.addEventListener("resize", onWindowResize);

    const observer = new ResizeObserver(() => syncSize());
    observer.observe(container);

    window.requestAnimationFrame(() => {
      syncSize();
      term.focus();
    });

    return () => {
      disposed = true;
      unlisten?.();
      window.removeEventListener("resize", onWindowResize);
      observer.disconnect();
      inputDisposable.dispose();
      term.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [syncSize]);

  // Follow the selected task: reset, replay the log tail, then stream live.
  useEffect(() => {
    const term = terminalRef.current;
    taskIdRef.current = taskId;
    if (!term) return;

    term.reset();
    if (!taskId) return;

    let cancelled = false;
    void agentApi
      .taskLog(taskId)
      .then(({ data }) => {
        if (cancelled || taskIdRef.current !== taskId) return;
        if (data) term.write(data);
      })
      .catch(() => {
        /* a missing log just means there is nothing to replay */
      })
      .finally(() => {
        if (!cancelled) window.requestAnimationFrame(syncSize);
      });

    window.requestAnimationFrame(syncSize);
    return () => {
      cancelled = true;
    };
  }, [taskId, syncSize]);

  return (
    <div
      ref={containerRef}
      onMouseDown={() => terminalRef.current?.focus()}
      className="h-full w-full px-2 py-1"
    />
  );
}
