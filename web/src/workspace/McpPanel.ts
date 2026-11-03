import {
  t,
  type AgentMcpView,
  type Locale,
  type McpServerEntry,
  type McpTransport,
} from '@allibot/shared';
import { createElement, useState, type ReactNode } from 'react';
import {
  emptyMcpEntry,
  entriesSaveBody,
  formatArgsText,
  formatEnvNamesText,
  initialMcpEntries,
  initialMcpRaw,
  parseArgsText,
  parseEnvNamesText,
  rawSaveBody,
  withTransport,
  type McpSaveBody,
} from './mcp-tab.ts';

export interface McpPanelProps {
  locale: Locale;
  /** The same file the backend assembles from; null states "not read yet". */
  mcp: AgentMcpView | null;
  /** Host write: PUT /api/agents/{id}/mcp with exactly one of entries / raw. */
  onSave?: (body: McpSaveBody) => Promise<AgentMcpView | void>;
}

/**
 * Agent 详情 mcp 页签 (#47 / D6.5).
 *
 * Upper block: the structured entries form. Lower block: the raw textarea of
 * the same file. Both call the one host write and both are initialized from the
 * one `GET /api/agents/{id}/mcp` reading, so they cannot drift into two
 * sources. The panel stays mounted while another tab is shown (the parent toggles
 * `hidden`), so unsubmitted drafts survive a tab switch. It writes no URL and
 * fetches nothing itself.
 */
export function McpPanel({ locale, mcp, onSave }: McpPanelProps) {
  const [entries, setEntries] = useState<McpServerEntry[]>(() => initialMcpEntries(mcp));
  const [raw, setRaw] = useState<string>(() => initialMcpRaw(mcp));
  const [saving, setSaving] = useState<'entries' | 'raw' | null>(null);
  const [failed, setFailed] = useState<'entries' | 'raw' | null>(null);

  function applySaved(view: AgentMcpView | void): void {
    if (view !== undefined) {
      setEntries(initialMcpEntries(view));
      setRaw(view.raw);
    }
  }

  function updateEntry(index: number, next: McpServerEntry): void {
    setEntries((current) => current.map((entry, at) => (at === index ? next : entry)));
  }

  function saveEntries(): void {
    if (onSave === undefined || saving !== null) {
      return;
    }
    setSaving('entries');
    setFailed(null);
    onSave(entriesSaveBody(entries))
      .then((view) => {
        applySaved(view);
        setSaving(null);
      })
      .catch(() => {
        setSaving(null);
        setFailed('entries');
      });
  }

  function saveRaw(): void {
    if (onSave === undefined || saving !== null) {
      return;
    }
    setSaving('raw');
    setFailed(null);
    onSave(rawSaveBody(raw))
      .then((view) => {
        applySaved(view);
        setSaving(null);
      })
      .catch(() => {
        setSaving(null);
        setFailed('raw');
      });
  }

  function field(label: string, control: ReactNode, name: string): ReactNode {
    return createElement(
      'label',
      { className: 'mcp-entry__field', 'data-field': name },
      createElement('span', { className: 'mcp-entry__label' }, label),
      control,
    );
  }

  function transportSelect(entry: McpServerEntry, index: number): ReactNode {
    return createElement(
      'select',
      {
        className: 'mcp-entry__transport',
        value: entry.transport,
        'data-mcp-transport': entry.name,
        onChange: (event: { target: { value: string } }) =>
          updateEntry(index, withTransport(entry, event.target.value as McpTransport)),
      },
      ...(['stdio', 'http', 'sse'] as const).map((transport) =>
        createElement('option', { key: transport, value: transport }, transport),
      ),
    );
  }

  function entryFields(entry: McpServerEntry, index: number): ReactNode[] {
    const fields: ReactNode[] = [
      field(
        t(locale, 'workspace.agentDetail.mcp.name'),
        createElement('input', {
          className: 'mcp-entry__name',
          value: entry.name,
          'data-mcp-name': String(index),
          onChange: (event: { target: { value: string } }) =>
            updateEntry(index, { ...entry, name: event.target.value }),
        }),
        'mcp-name',
      ),
      field(
        t(locale, 'workspace.agentDetail.mcp.transport'),
        transportSelect(entry, index),
        'mcp-transport',
      ),
      field(
        t(locale, 'workspace.agentDetail.mcp.enabled'),
        createElement('input', {
          type: 'checkbox',
          checked: entry.enabled,
          'data-mcp-enabled': String(index),
          onChange: (event: { target: { checked: boolean } }) =>
            updateEntry(index, { ...entry, enabled: event.target.checked }),
        }),
        'mcp-enabled',
      ),
    ];
    if (entry.transport === 'stdio') {
      fields.push(
        field(
          t(locale, 'workspace.agentDetail.mcp.command'),
          createElement('input', {
            className: 'mcp-entry__command',
            value: entry.command ?? '',
            'data-mcp-command': String(index),
            onChange: (event: { target: { value: string } }) =>
              updateEntry(index, { ...entry, command: event.target.value }),
          }),
          'mcp-command',
        ),
        field(
          t(locale, 'workspace.agentDetail.mcp.args'),
          createElement('textarea', {
            className: 'mcp-entry__args',
            value: formatArgsText(entry),
            'data-mcp-args': String(index),
            onChange: (event: { target: { value: string } }) =>
              updateEntry(index, { ...entry, args: parseArgsText(event.target.value) }),
          }),
          'mcp-args',
        ),
      );
    } else {
      fields.push(
        field(
          t(locale, 'workspace.agentDetail.mcp.url'),
          createElement('input', {
            className: 'mcp-entry__url',
            value: entry.url ?? '',
            'data-mcp-url': String(index),
            onChange: (event: { target: { value: string } }) =>
              updateEntry(index, { ...entry, url: event.target.value }),
          }),
          'mcp-url',
        ),
      );
    }
    fields.push(
      field(
        t(locale, 'workspace.agentDetail.mcp.envNames'),
        createElement('input', {
          className: 'mcp-entry__env-names',
          value: formatEnvNamesText(entry),
          'data-mcp-env-names': String(index),
          onChange: (event: { target: { value: string } }) =>
            updateEntry(index, {
              ...entry,
              env_names: parseEnvNamesText(event.target.value),
            }),
        }),
        'mcp-env-names',
      ),
      createElement(
        'button',
        {
          type: 'button',
          className: 'mcp-entry__remove',
          'data-action': 'remove-mcp-entry',
          'data-mcp-index': String(index),
          onClick: () => setEntries((current) => current.filter((_, at) => at !== index)),
        },
        t(locale, 'workspace.agentDetail.mcp.removeEntry'),
      ),
    );
    return fields;
  }

  const entriesBlock = createElement(
    'section',
    { className: 'mcp-block', 'data-mcp-block': 'entries' },
    createElement(
      'h4',
      { className: 'mcp-block__heading' },
      t(locale, 'workspace.agentDetail.mcp.entries'),
    ),
    createElement(
      'p',
      { className: 'mcp-block__hint' },
      t(locale, 'workspace.agentDetail.mcp.consent'),
    ),
    entries.length === 0
      ? createElement(
          'p',
          { className: 'mcp-block__empty', 'data-field': 'mcp-entries-empty' },
          t(locale, 'workspace.agentDetail.mcp.entriesEmpty'),
        )
      : createElement(
          'ol',
          { className: 'mcp-entry-list' },
          ...entries.map((entry, index) =>
            createElement(
              'li',
              { key: index, className: 'mcp-entry', 'data-mcp-entry': String(index) },
              ...entryFields(entry, index),
            ),
          ),
        ),
    createElement(
      'div',
      { className: 'mcp-block__actions' },
      createElement(
        'button',
        {
          type: 'button',
          className: 'mcp-block__add',
          'data-action': 'add-mcp-entry',
          onClick: () =>
            setEntries((current) => [...current, emptyMcpEntry()]),
        },
        t(locale, 'workspace.agentDetail.mcp.addEntry'),
      ),
      onSave === undefined
        ? null
        : createElement(
            'button',
            {
              type: 'button',
              className: 'mcp-block__save',
              'data-action': 'save-mcp-entries',
              disabled: saving !== null,
              onClick: saveEntries,
            },
            saving === 'entries'
              ? t(locale, 'workspace.agentDetail.mcp.saving')
              : t(locale, 'workspace.agentDetail.mcp.saveEntries'),
          ),
      failed === 'entries'
        ? createElement(
            'span',
            { className: 'mcp-block__error', role: 'alert' },
            t(locale, 'workspace.agentDetail.mcp.saveFailed'),
          )
        : null,
    ),
  );

  const rawBlock = createElement(
    'section',
    { className: 'mcp-block', 'data-mcp-block': 'raw' },
    createElement(
      'h4',
      { className: 'mcp-block__heading' },
      t(locale, 'workspace.agentDetail.mcp.raw'),
    ),
    createElement('textarea', {
      className: 'mcp-block__raw',
      value: raw,
      'data-field': 'mcp-raw',
      rows: 14,
      spellCheck: false,
      onChange: (event: { target: { value: string } }) => setRaw(event.target.value),
    }),
    createElement(
      'div',
      { className: 'mcp-block__actions' },
      onSave === undefined
        ? null
        : createElement(
            'button',
            {
              type: 'button',
              className: 'mcp-block__save',
              'data-action': 'save-mcp-raw',
              disabled: saving !== null,
              onClick: saveRaw,
            },
            saving === 'raw'
              ? t(locale, 'workspace.agentDetail.mcp.saving')
              : t(locale, 'workspace.agentDetail.mcp.saveRaw'),
          ),
      failed === 'raw'
        ? createElement(
            'span',
            { className: 'mcp-block__error', role: 'alert' },
            t(locale, 'workspace.agentDetail.mcp.saveFailed'),
          )
        : null,
    ),
  );

  return createElement(
    'div',
    { className: 'mcp-tab', 'data-section': 'mcp' },
    createElement(
      'p',
      { className: 'mcp-tab__same-file' },
      t(locale, 'workspace.agentDetail.mcp.sameFile'),
    ),
    mcp !== null && mcp.diagnostic !== null
      ? createElement(
          'p',
          {
            className: 'mcp-tab__diagnostic',
            role: 'status',
            'data-field': 'mcp-diagnostic',
          },
          t(locale, 'workspace.agentDetail.mcp.diagnostic'),
          '：',
          mcp.diagnostic,
        )
      : null,
    mcp !== null && !mcp.present
      ? createElement(
          'p',
          { className: 'mcp-tab__missing', 'data-field': 'mcp-file-missing' },
          t(locale, 'workspace.agentDetail.mcp.fileMissing'),
        )
      : null,
    entriesBlock,
    rawBlock,
  );
}
