import type { PlanTaskView } from '@allibot/shared';
import type {
  EditFileRequest,
  GlobFileRequest,
  GrepFileRequest,
  PlanTaskUpdateRequest,
  RoundFileToolResult,
  RoundMcpCallResult,
  RoundShellResult,
  RoundWebFetchResult,
  RoundWebSearchResult,
  TeamAssignRequest,
  TeamAssignToolResult,
  WriteFileRequest,
} from './agent-seam.js';
import { MAX_GREP_FILES } from './docker-files.js';
import { MAX_SHELL_OUTPUT_BYTES } from './local-shell.js';
import type { ToolAnswer, ToolCopy } from './tool-specs.js';
import { MAX_WEB_SEARCH_HITS } from './web-tools.js';
import { MAX_GREP_MATCHES } from './workspace-files.js';

/**
 * 工具结果整形 (D5 / D6): one function per tool, turning the face's own result
 * into the text the model reads back — a structured summary first, the body the
 * answer needs after it, and a stable error code on the first line of a failure.
 *
 * Every function here is a pure reading of one face's result plus the round's
 * translation function: no database, no gate, no session, no registry. The
 * registry in `tool-specs.ts` owns which tools a round offers and what arguments
 * they accept; this module owns what the model reads back, so a tool's shape can
 * change without touching the registry, and a new tool can be offered without
 * touching this file.
 *
 * `ToolAnswer` / `ToolCopy` are imported back from `tool-specs.ts` as types only,
 * so this module and the registry are not a runtime cycle.
 */

/**
 * The result's own state on its first line. `io-error` is the file face's own
 * catch-all code, so a failed result that somehow carries none still reports a
 * code the model can act on.
 */
function statusLine(name: string, result: RoundFileToolResult): string {
  return result.ok ? `[${name}] ok` : `[${name}] error: ${result.error ?? 'io-error'}`;
}

/** A failed file-tool result: state, the request it answers, then the face's message. */
function shapeFileFailure(
  name: string,
  request: readonly string[],
  result: RoundFileToolResult,
): ToolAnswer {
  const lines = [statusLine(name, result), ...request];
  if (result.message !== undefined) {
    lines.push(`message: ${result.message}`);
  }
  return { ok: false, content: lines.join('\n') };
}

/** One `Read` result as the model reads it: summary first, body after it. */
export function shapeRead(requested: string, result: RoundFileToolResult): ToolAnswer {
  if (!result.ok) {
    return shapeFileFailure('Read', [`path: ${requested}`], result);
  }
  const lines = [statusLine('Read', result), `path: ${result.path ?? requested}`];
  if (result.scope !== undefined) {
    lines.push(`root: ${result.scope}`);
  }
  if (result.bytes !== undefined) {
    lines.push(`bytes: ${result.bytes}`);
  }
  lines.push('content:', result.content ?? '');
  return { ok: true, content: lines.join('\n') };
}

/** One `Glob` result: the request, then one path per line. */
export function shapeGlob(requested: GlobFileRequest, result: RoundFileToolResult): ToolAnswer {
  const request = [
    `pattern: ${requested.pattern}`,
    ...(requested.path === undefined ? [] : [`base: ${requested.path}`]),
  ];
  if (!result.ok) {
    return shapeFileFailure('Glob', request, result);
  }
  const lines = [statusLine('Glob', result), ...request];
  if (result.scope !== undefined) {
    lines.push(`root: ${result.scope}`);
  }
  const paths = result.paths ?? [];
  lines.push(`files: ${paths.length}`);
  lines.push(...(paths.length === 0 ? ['(no file matched)'] : paths));
  return { ok: true, content: lines.join('\n') };
}

/**
 * One `Grep` result: the request, then one `path:line: text` line per hit.
 *
 * `t` is the round's translation function — the same entry point every backend
 * string uses, bound from `tFromDb` by the caller that holds the database —
 * passed in rather than imported so this module never reads the language
 * preference itself. Exported so a test can pin the model-visible capped copy
 * without a provider round trip.
 */
export function shapeGrep(
  requested: GrepFileRequest,
  result: RoundFileToolResult,
  t: ToolCopy,
): ToolAnswer {
  const request = [
    `pattern: ${requested.pattern}`,
    ...(requested.path === undefined ? [] : [`base: ${requested.path}`]),
  ];
  if (!result.ok) {
    return shapeFileFailure('Grep', request, result);
  }
  const lines = [statusLine('Grep', result), ...request];
  if (result.scope !== undefined) {
    lines.push(`root: ${result.scope}`);
  }
  const matches = result.matches ?? [];
  lines.push(`matches: ${matches.length}`);
  if (result.capped === 'matches') {
    lines.push(t('tool.grep.capped.matches', { limit: MAX_GREP_MATCHES }));
  } else if (result.capped === 'files') {
    lines.push(t('tool.grep.capped.files', { limit: MAX_GREP_FILES }));
  }
  lines.push(
    ...(matches.length === 0
      ? ['(no line matched)']
      : matches.map((match) => `${match.path}:${match.line}: ${match.text}`)),
  );
  return { ok: true, content: lines.join('\n') };
}

/**
 * One `Write` result: the request, then how much landed. The face's own result
 * carries no content echo, so a write of a huge file never doubles the re-feed.
 */
export function shapeWrite(requested: WriteFileRequest, result: RoundFileToolResult): ToolAnswer {
  const request = [`path: ${requested.path}`];
  if (!result.ok) {
    return shapeFileFailure('Write', request, result);
  }
  const lines = [statusLine('Write', result), `path: ${result.path ?? requested.path}`];
  if (result.scope !== undefined) {
    lines.push(`root: ${result.scope}`);
  }
  if (result.bytes !== undefined) {
    lines.push(`bytes: ${result.bytes}`);
  }
  return { ok: true, content: lines.join('\n') };
}

/** One `Edit` result: the request, then how many occurrences were replaced. */
export function shapeEdit(requested: EditFileRequest, result: RoundFileToolResult): ToolAnswer {
  const request = [`path: ${requested.path}`];
  if (!result.ok) {
    return shapeFileFailure('Edit', request, result);
  }
  const lines = [statusLine('Edit', result), `path: ${result.path ?? requested.path}`];
  if (result.scope !== undefined) {
    lines.push(`root: ${result.scope}`);
  }
  if (result.replacements !== undefined) {
    lines.push(`replacements: ${result.replacements}`);
  }
  return { ok: true, content: lines.join('\n') };
}

/** One `TaskList` result: the run's size, then one `- [status] title (id)` per item. */
export function shapeTaskList(tasks: readonly PlanTaskView[]): ToolAnswer {
  const lines = ['[TaskList] ok', `tasks: ${tasks.length}`];
  if (tasks.length === 0) {
    lines.push("(this run's plan has no items)");
  } else {
    lines.push(...tasks.map((task) => `- [${task.status}] ${task.title} (${task.id})`));
  }
  return { ok: true, content: lines.join('\n') };
}

/** One `TaskGet` result: the item's fields, or the stable `not-found` code. */
export function shapeTaskGet(requested: string, task: PlanTaskView | null): ToolAnswer {
  if (task === null) {
    return {
      ok: false,
      content: [
        '[TaskGet] error: not-found',
        `id: ${requested}`,
        "message: this id is not an item of this round's plan run",
      ].join('\n'),
    };
  }
  return { ok: true, content: planTaskLines('TaskGet', task) };
}

/** One `TaskCreate` result: the item the call appended at the end of the run. */
export function shapeTaskCreate(task: PlanTaskView): ToolAnswer {
  return { ok: true, content: planTaskLines('TaskCreate', task) };
}

/** One `TaskUpdate` result: the item as it now reads, or the stable `not-found` code. */
export function shapeTaskUpdate(requested: PlanTaskUpdateRequest, task: PlanTaskView | null): ToolAnswer {
  if (task === null) {
    return {
      ok: false,
      content: [
        '[TaskUpdate] error: not-found',
        `id: ${requested.id}`,
        "message: this id is not an item of this round's plan run",
      ].join('\n'),
    };
  }
  return { ok: true, content: planTaskLines('TaskUpdate', task) };
}

/** One Plan item as the model reads it: the call's own state line, then its fields. */
function planTaskLines(name: string, task: PlanTaskView): string {
  return [
    `[${name}] ok`,
    `id: ${task.id}`,
    `title: ${task.title}`,
    `status: ${task.status}`,
    `position: ${task.position}`,
  ].join('\n');
}

/**
 * One `TeamAssign` result: the request, then the assignment's own facts and the
 * member's output. The output is the only place a sub-round's answer reaches the
 * leader — it is never persisted as a message — so the re-feed cap applies to it
 * like to any other result.
 */
export function shapeTeamAssign(requested: TeamAssignRequest, result: TeamAssignToolResult): ToolAnswer {
  const request = [
    `member_id: ${requested.member_id}`,
    `instruction: ${requested.instruction}`,
  ];
  if (!result.ok) {
    return {
      ok: false,
      content: [
        `[TeamAssign] error: ${result.code ?? 'member_failed'}`,
        ...request,
        `state: ${result.state ?? 'none'}`,
        ...(result.reason === null ? [] : [`message: ${result.reason}`]),
      ].join('\n'),
    };
  }
  return {
    ok: true,
    content: [
      '[TeamAssign] ok',
      ...request,
      `assignment-id: ${result.assignment_id ?? 'none'}`,
      `state: ${result.state ?? 'none'}`,
      `jump-consumed: ${result.jump_consumed}`,
      ...(result.reply_excerpt === null ? [] : [`excerpt: ${result.reply_excerpt}`]),
      'output:',
      result.output ?? '',
    ].join('\n'),
  };
}

/**
 * One MCP tool result as the model reads it: the tool's product name, the call
 * it answers, and — when the call failed — the stable code the round's own face
 * produced (`denied`, `tool-error`, `connection`, `unavailable`, …).
 *
 * A denial is a result here, exactly as it is for every other tool: the round
 * continues with what the model makes of `DENIED`. The server's own body is
 * kept whole rather than summarized — it is the tool's answer, and the re-feed
 * cap is what bounds its size (D6).
 */
export function shapeMcpCall(
  server: string,
  tool: string,
  result: RoundMcpCallResult,
): ToolAnswer {
  const name = `mcp:${server}/${tool}`;
  const call = [`server: ${server}`, `tool: ${tool}`];
  if (!result.ok) {
    return {
      ok: false,
      content: [
        `[${name}] error: ${result.error ?? 'tool-error'}`,
        ...call,
        ...(result.message === undefined ? [] : [`message: ${result.message}`]),
        ...(result.content === undefined ? [] : ['content:', result.content]),
      ].join('\n'),
    };
  }
  return {
    ok: true,
    content: [`[${name}] ok`, ...call, 'content:', result.content ?? ''].join('\n'),
  };
}

/**
 * One `Bash` result as the model reads it: the command, the directory it ran in,
 * its exit code, and — **before either stream** — the one fact that would
 * otherwise be lost: the output was cut at the shell's own cap.
 *
 * The order is the point. A long output is cut by the re-feed cap at its head,
 * so a truncation notice printed after the body is the first thing the model
 * never reads (D6); stating it above the bodies is what makes it survive. The
 * same discipline as `Grep`'s cap: the model must not read a cut result as a
 * complete one.
 *
 * A completed command is a successful call whatever its exit code — the code is
 * stated rather than folded into an error — so a non-zero exit and a missing
 * binary reach the model as this one result.
 */
export function shapeShell(command: string, result: RoundShellResult, t: ToolCopy): ToolAnswer {
  if (!result.ok) {
    return {
      ok: false,
      content: [
        `[Bash] error: ${result.error ?? 'spawn-failed'}`,
        `command: ${command}`,
        ...(result.message === undefined ? [] : [`message: ${result.message}`]),
      ].join('\n'),
    };
  }
  return {
    ok: true,
    content: [
      '[Bash] ok',
      `command: ${command}`,
      ...(result.cwd === undefined ? [] : [`cwd: ${result.cwd}`]),
      `exit-code: ${result.exit_code ?? 'none'}`,
      ...(result.output_truncated === true
        ? [t('tool.bash.output.truncated', { limit: MAX_SHELL_OUTPUT_BYTES })]
        : []),
      'stdout:',
      result.stdout ?? '',
      'stderr:',
      result.stderr ?? '',
    ].join('\n'),
  };
}

/**
 * One `web_search` result as the model reads it: the query, the provider that
 * answered, the hit count and one numbered `title / url / snippet` block per
 * hit — the read-result shape, not a JSON dump (D13). The `capped` line is
 * printed only when the face said the hit-count cap cut the list, so a result
 * that holds exactly the cap's worth of hits never claims to be cut.
 */
export function shapeWebSearch(query: string, result: RoundWebSearchResult): ToolAnswer {
  const request = [`query: ${query}`, `source: ${result.source}`];
  if (!result.ok) {
    return {
      ok: false,
      content: [
        `[web_search] error: ${result.error ?? 'provider-error'}`,
        ...request,
        ...(result.message === undefined ? [] : [`message: ${result.message}`]),
      ].join('\n'),
    };
  }
  const lines = ['[web_search] ok', ...request];
  if (result.hits !== undefined) {
    lines.push(`hits: ${result.hits.length}`);
    if (result.capped === 'hits') {
      lines.push(`capped: hits (limit ${MAX_WEB_SEARCH_HITS})`);
    }
    lines.push(
      ...(result.hits.length === 0
        ? ['(no hit)']
        : result.hits.flatMap((hit, index) => [
            `${index + 1}. ${hit.title}`,
            `   url: ${hit.url}`,
            `   ${hit.snippet}`,
          ])),
    );
  }
  if (result.content !== undefined) {
    lines.push('content:', result.content);
  }
  return { ok: true, content: lines.join('\n') };
}

/**
 * One `fetch` result as the model reads it: the host, the status and the body
 * the page returned. The URL itself is not echoed — the host is the call's
 * subject (D5), and the body is the answer. A denial or a refused cross-host
 * redirect states its stable code on the first line like every other tool
 * error.
 */
export function shapeFetch(result: RoundWebFetchResult): ToolAnswer {
  if (!result.ok) {
    return {
      ok: false,
      content: [
        `[fetch] error: ${result.error ?? 'request-failed'}`,
        ...(result.host === undefined ? [] : [`host: ${result.host}`]),
        ...(result.status === undefined ? [] : [`status: ${result.status}`]),
        ...(result.message === undefined ? [] : [`message: ${result.message}`]),
      ].join('\n'),
    };
  }
  return {
    ok: true,
    content: [
      '[fetch] ok',
      `host: ${result.host ?? ''}`,
      `status: ${result.status ?? 0}`,
      'content:',
      result.content ?? '',
    ].join('\n'),
  };
}
