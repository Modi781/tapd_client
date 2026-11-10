import { featureCommand } from "./feature";
import type { McpClientId } from "./api";

export type McpImportResult = {
  /** Config file that was written. */
  path: string;
  /** Backup created before changing the file, if anything changed. */
  backupPath: string | null;
  /** False when the file already had the tapd server entry. */
  changed: boolean;
  /** True when the tapd server entry is present after the call. */
  imported: boolean;
};

export const mcpApi = {
  /** Merges the bundled tapd-mcp sidecar into the client's user-scope config. */
  importClient: (client: McpClientId) =>
    featureCommand<McpImportResult>("mcp_import_client", { client }),
};
