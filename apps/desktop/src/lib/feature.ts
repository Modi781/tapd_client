import { invoke } from "@tauri-apps/api/core";

/** Calls a feature command routed to the M6/M7 modules. */
export const featureCommand = <T>(
  name: string,
  payload: unknown = {},
): Promise<T> => invoke<T>("feature_command", { name, payload });

export type ToastFn = (kind: "ok" | "error", text: string) => void;

export type SettingsSectionProps = {
  toast: ToastFn;
};
