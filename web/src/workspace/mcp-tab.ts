import type { AgentMcpView, McpServerEntry, McpTransport } from '@allibot/shared';

/**
 * mcp 页签的草稿助手 (#47 / D6.5).
 *
 * The structured block and the raw block are two presentations of the same
 * Agent-home `mcp.json`; neither keeps a second source of truth. These pure
 * helpers only translate between form text and the one entry shape the backend
 * validates, so the component stays a renderer and the data contract is
 * testable without a browser.
 */

export type McpSaveBody = { entries: McpServerEntry[] } | { raw: string };

export function initialMcpEntries(mcp: AgentMcpView | null): McpServerEntry[] {
  if (mcp === null) {
    return [];
  }
  return mcp.entries.map(cloneEntry);
}

export function initialMcpRaw(mcp: AgentMcpView | null): string {
  return mcp?.raw ?? '';
}

export function cloneEntry(entry: McpServerEntry): McpServerEntry {
  return {
    ...entry,
    ...(entry.args === undefined ? {} : { args: [...entry.args] }),
    ...(entry.env_names === undefined ? {} : { env_names: [...entry.env_names] }),
  };
}

export function emptyMcpEntry(): McpServerEntry {
  return { name: '', transport: 'stdio', enabled: true, command: '', args: [] };
}

/** Switching transport drops the other transport's fields (server rejects them). */
export function withTransport(entry: McpServerEntry, transport: McpTransport): McpServerEntry {
  const next: McpServerEntry = {
    name: entry.name,
    transport,
    enabled: entry.enabled,
    ...(entry.env_names === undefined ? {} : { env_names: [...entry.env_names] }),
  };
  if (transport === 'stdio') {
    next.command = entry.command ?? '';
    next.args = entry.args === undefined ? [] : [...entry.args];
  } else {
    next.url = entry.url ?? '';
  }
  return next;
}

export function parseArgsText(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function formatArgsText(entry: McpServerEntry): string {
  return (entry.args ?? []).join('\n');
}

export function parseEnvNamesText(text: string): string[] {
  return text
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

export function formatEnvNamesText(entry: McpServerEntry): string {
  return (entry.env_names ?? []).join(', ');
}

/** The structured block always writes `{entries}`; the raw block `{raw}`. */
export function entriesSaveBody(entries: readonly McpServerEntry[]): McpSaveBody {
  return { entries: entries.map(cloneEntry) };
}

export function rawSaveBody(raw: string): McpSaveBody {
  return { raw };
}
