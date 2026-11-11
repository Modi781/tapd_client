import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import { initAppearance } from "./lib/appearance";
import { IslandWindow } from "./windows/IslandWindow";
import "./styles.css";

let label = "main";
try {
  label = getCurrentWindow().label;
} catch {
  // Browser preview outside Tauri: fall back to the main app.
}

const isOverlay = label === "island" || label === "notification";
if (!isOverlay) initAppearance();

const content = isOverlay ? (
  <IslandWindow />
) : (
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(content);
