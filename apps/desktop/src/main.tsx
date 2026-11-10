import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import { AgentConsoleWindow } from "./windows/AgentConsoleWindow";
import { NotificationWindow } from "./windows/NotificationWindow";
import "./styles.css";

let label = "main";
try {
  label = getCurrentWindow().label;
} catch {
  // Browser preview outside Tauri: fall back to the main app.
}

const content =
  label === "notification" ? (
    <NotificationWindow />
  ) : label === "agent-console" ? (
    <AgentConsoleWindow />
  ) : (
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(content);
