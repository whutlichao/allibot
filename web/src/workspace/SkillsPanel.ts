import {
  t,
  type AgentSkillCandidatesView,
  type AgentSkillDetailView,
  type AgentSkillsView,
  type Locale,
  type SkillView,
} from '@allibot/shared';
import { createElement, useState, type ReactNode } from 'react';
import {
  importableCandidates,
  resolveCandidateName,
  selectedSkill,
  skillHashPrefix,
} from './skills-tab.ts';

/** The host's Skill face for the Agent detail skills tab. */
export interface AgentSkillsFace {
  /** `GET /api/agents/{id}/skills`; null while it is loading. */
  view: AgentSkillsView | null;
  /** The selected skill's metadata + SKILL.md text; null while loading. */
  detail: AgentSkillDetailView | null;
  /** `GET /api/agents/{id}/skill-candidates`; null while it is loading. */
  candidates: AgentSkillCandidatesView | null;
  onSelect?: (name: string) => void;
  onRefreshCandidates?: () => void | Promise<void>;
  onImport?: (name: string) => void | Promise<void>;
  onImportAll?: () => void | Promise<void>;
  onToggleEnabled?: (name: string, enabled: boolean) => void | Promise<void>;
  onDelete?: (name: string) => void | Promise<void>;
}

export interface SkillsPanelProps {
  locale: Locale;
  face: AgentSkillsFace;
}

type Failure = 'refresh' | 'import' | 'import-all' | 'toggle' | 'delete' | null;

/**
 * Agent 详情 skills 页签 (#48 / D6.5).
 *
 * Left: the installed skill list (name, hash prefix, enabled state) with the
 * only enable/disable entry in its row. Right: metadata plus the SKILL.md text
 * as configuration text (a `<pre>` block, never a chat markdown bubble) and the
 * delete action. Top: single import from `~/.agents/skills/`, a candidate
 * refresh and import-all. The panel fetches nothing itself and opens no route;
 * it stays mounted while another tab is shown, so its selection survives.
 */
export function SkillsPanel({ locale, face }: SkillsPanelProps) {
  const { view, detail, candidates } = face;
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [candidateName, setCandidateName] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure>(null);

  const importable = importableCandidates(candidates);
  const chosenCandidate = resolveCandidateName(candidates, candidateName);
  const chosen = selectedSkill(view, selectedName);
  const importName = chosenCandidate;

  function run(
    work: Promise<void> | void | undefined,
    failed: Failure,
  ): void {
    if (work === undefined) {
      return;
    }
    setFailure(null);
    Promise.resolve(work)
      .then(() => undefined)
      .catch(() => setFailure(failed));
  }

  function select(skill: SkillView): void {
    setSelectedName(skill.name);
    face.onSelect?.(skill.name);
  }

  function toggle(skill: SkillView): void {
    if (face.onToggleEnabled === undefined || busy !== null) {
      return;
    }
    setBusy(`toggle:${skill.name}`);
    run(
      Promise.resolve(face.onToggleEnabled(skill.name, !skill.enabled)).finally(() =>
        setBusy(null),
      ),
      'toggle',
    );
  }

  function importSelected(): void {
    if (face.onImport === undefined || busy !== null || importName === null) {
      return;
    }
    setBusy('import');
    run(
      Promise.resolve(face.onImport(importName)).finally(() => setBusy(null)),
      'import',
    );
  }

  function importAll(): void {
    if (face.onImportAll === undefined || busy !== null) {
      return;
    }
    setBusy('import-all');
    run(Promise.resolve(face.onImportAll()).finally(() => setBusy(null)), 'import-all');
  }

  function refresh(): void {
    if (face.onRefreshCandidates === undefined || busy !== null) {
      return;
    }
    setBusy('refresh');
    run(Promise.resolve(face.onRefreshCandidates()).finally(() => setBusy(null)), 'refresh');
  }

  function remove(skill: SkillView): void {
    if (face.onDelete === undefined || busy !== null) {
      return;
    }
    setBusy(`delete:${skill.name}`);
    run(
      Promise.resolve(face.onDelete(skill.name)).finally(() => setBusy(null)),
      'delete',
    );
  }

  const importControls: ReactNode[] = [
    createElement(
      'label',
      { key: 'candidate', className: 'skills-tab__pick' },
      createElement(
        'span',
        { className: 'skills-tab__pick-label' },
        t(locale, 'workspace.agentDetail.skills.importTitle'),
      ),
      candidates === null
        ? createElement(
            'span',
            { className: 'skills-tab__hint', 'data-field': 'skill-candidates-pending' },
            t(locale, 'workspace.agentDetail.skills.candidatesPending'),
          )
        : candidates.available === false
          ? createElement(
              'span',
              { className: 'skills-tab__hint', 'data-field': 'skill-candidates-empty' },
              t(locale, 'workspace.agentDetail.skills.candidatesUnavailable'),
            )
          : importable.length === 0
            ? createElement(
                'span',
                { className: 'skills-tab__hint', 'data-field': 'skill-candidates-empty' },
                t(locale, 'workspace.agentDetail.skills.candidatesEmpty'),
              )
            : createElement(
                'select',
                {
                  className: 'skills-tab__select',
                  'data-field': 'skill-candidate',
                  value: importName ?? '',
                  onChange: (event: { target: { value: string } }) =>
                    setCandidateName(event.target.value),
                },
                ...importable.map((candidate) =>
                  createElement(
                    'option',
                    { key: candidate.name, value: candidate.name },
                    `${candidate.name} — ${
                      candidate.importable && !candidate.installed
                        ? t(locale, 'workspace.agentDetail.skills.candidateImportable')
                        : t(locale, 'workspace.agentDetail.skills.candidateInstalled')
                    }`,
                  ),
                ),
              ),
    ),
    createElement(
      'button',
      {
        key: 'import',
        type: 'button',
        className: 'skills-tab__action',
        'data-action': 'import-skill',
        disabled: busy !== null || face.onImport === undefined || importName === null,
        onClick: importSelected,
      },
      busy === 'import'
        ? t(locale, 'workspace.agentDetail.skills.importing')
        : t(locale, 'workspace.agentDetail.skills.importSelected'),
    ),
    createElement(
      'button',
      {
        key: 'refresh',
        type: 'button',
        className: 'skills-tab__action',
        'data-action': 'refresh-skill-candidates',
        disabled: busy !== null || face.onRefreshCandidates === undefined,
        onClick: refresh,
      },
      t(locale, 'workspace.agentDetail.skills.refreshCandidates'),
    ),
    createElement(
      'button',
      {
        key: 'import-all',
        type: 'button',
        className: 'skills-tab__action',
        'data-action': 'import-all-skills',
        disabled: busy !== null || face.onImportAll === undefined || importable.length === 0,
        onClick: importAll,
      },
      t(locale, 'workspace.agentDetail.skills.importAll'),
    ),
    failure === 'refresh'
      ? createElement(
          'span',
          { key: 'refresh-failed', className: 'skills-tab__error', role: 'alert' },
          t(locale, 'workspace.agentDetail.skills.refreshFailed'),
        )
      : null,
    failure === 'import' || failure === 'import-all'
      ? createElement(
          'span',
          { key: 'import-failed', className: 'skills-tab__error', role: 'alert' },
          t(locale, 'workspace.agentDetail.skills.importFailed'),
        )
      : null,
  ];

  const list =
    view === null
      ? createElement(
          'p',
          { className: 'skills-tab__pending', 'data-field': 'skills-pending' },
          t(locale, 'workspace.agentDetail.skills.pending'),
        )
      : view.skills.length === 0
        ? createElement(
            'p',
            { className: 'skills-tab__empty', 'data-field': 'skills-empty' },
            t(locale, 'workspace.agentDetail.skills.empty'),
          )
        : createElement(
            'ol',
            { className: 'skills-list', 'data-field': 'skills-list' },
            ...view.skills.map((skill) =>
              createElement(
                'li',
                {
                  key: skill.id,
                  className:
                    chosen?.id === skill.id
                      ? 'skills-list__row skills-list__row--selected'
                      : 'skills-list__row',
                  'data-skill-name': skill.name,
                  'data-skill-hash': skillHashPrefix(skill.content_hash),
                  'data-skill-enabled': skill.enabled ? 'true' : 'false',
                },
                createElement(
                  'button',
                  {
                    type: 'button',
                    className: 'skills-list__select',
                    'data-action': 'select-skill',
                    'data-skill-name': skill.name,
                    'aria-current': chosen?.id === skill.id ? 'true' : 'false',
                    onClick: () => select(skill),
                  },
                  createElement('span', { className: 'skills-list__name' }, skill.name),
                  createElement(
                    'code',
                    { className: 'skills-list__hash' },
                    skillHashPrefix(skill.content_hash),
                  ),
                ),
                createElement(
                  'label',
                  { className: 'skills-list__toggle' },
                  createElement('input', {
                    type: 'checkbox',
                    checked: skill.enabled,
                    'data-action': 'toggle-skill',
                    'data-skill-name': skill.name,
                    'aria-label': t(locale, 'workspace.agentDetail.skills.enabledToggle', {
                      name: skill.name,
                    }),
                    disabled: busy !== null || face.onToggleEnabled === undefined,
                    onChange: () => toggle(skill),
                  }),
                  skill.enabled
                    ? t(locale, 'workspace.agentDetail.skills.enabled')
                    : t(locale, 'workspace.agentDetail.skills.disabled'),
                ),
              ),
            ),
          );

  function fact(field: string, label: string, value: ReactNode): ReactNode {
    return createElement(
      'div',
      { className: 'skills-detail__fact', 'data-field': field },
      createElement('span', { className: 'skills-detail__label' }, label),
      createElement('span', { className: 'skills-detail__value' }, value),
    );
  }

  const detailMatches =
    chosen !== null && detail !== null && detail.skill.name === chosen.name ? detail : null;
  const detailBody =
    detailMatches === null
      ? createElement(
          'p',
          { className: 'skills-tab__hint', 'data-field': 'skill-detail-pending' },
          t(locale, 'workspace.agentDetail.skills.selectHint'),
        )
      : createElement(
          'div',
          { className: 'skills-detail', 'data-section': 'skill-detail' },
          createElement(
            'h4',
            { className: 'skills-detail__name' },
            detailMatches.skill.name,
          ),
          createElement(
            'div',
            { className: 'skills-detail__facts' },
            fact(
              'skill-name',
              t(locale, 'workspace.agentDetail.skills.field.name'),
              detailMatches.skill.name,
            ),
            fact(
              'skill-hash',
              t(locale, 'workspace.agentDetail.skills.field.hash'),
              createElement('code', null, detailMatches.skill.content_hash),
            ),
            fact(
              'skill-source',
              t(locale, 'workspace.agentDetail.skills.field.source'),
              detailMatches.skill.source,
            ),
            fact(
              'skill-enabled',
              t(locale, 'workspace.agentDetail.skills.field.enabled'),
              detailMatches.skill.enabled
                ? t(locale, 'workspace.agentDetail.skills.enabled')
                : t(locale, 'workspace.agentDetail.skills.disabled'),
            ),
            fact(
              'skill-created',
              t(locale, 'workspace.agentDetail.skills.field.created'),
              detailMatches.skill.created_at,
            ),
            fact(
              'skill-updated',
              t(locale, 'workspace.agentDetail.skills.field.updated'),
              detailMatches.skill.updated_at,
            ),
          ),
          createElement(
            'h5',
            { className: 'skills-detail__heading' },
            t(locale, 'workspace.agentDetail.skills.markdown'),
          ),
          createElement(
            'pre',
            { className: 'skills-detail__markdown', 'data-field': 'skill-markdown' },
            detailMatches.markdown,
          ),
          face.onDelete === undefined
            ? null
            : createElement(
                'button',
                {
                  type: 'button',
                  className: 'skills-detail__delete',
                  'data-action': 'delete-skill',
                  'data-skill-name': detailMatches.skill.name,
                  disabled: busy !== null,
                  onClick: () => remove(detailMatches.skill),
                },
                busy === `delete:${detailMatches.skill.name}`
                  ? t(locale, 'workspace.agentDetail.skills.deleting')
                  : t(locale, 'workspace.agentDetail.skills.delete'),
              ),
          failure === 'toggle'
            ? createElement(
                'span',
                { className: 'skills-tab__error', role: 'alert' },
                t(locale, 'workspace.agentDetail.skills.toggleFailed'),
              )
            : null,
          failure === 'delete'
            ? createElement(
                'span',
                { className: 'skills-tab__error', role: 'alert' },
                t(locale, 'workspace.agentDetail.skills.deleteFailed'),
              )
            : null,
        );

  return createElement(
    'section',
    { className: 'skills-tab', 'data-section': 'skills' },
    createElement(
      'div',
      { className: 'skills-tab__top' },
      ...importControls,
    ),
    createElement(
      'div',
      { className: 'skills-tab__columns' },
      createElement(
        'div',
        { className: 'skills-tab__left' },
        createElement(
          'h4',
          { className: 'skills-tab__heading' },
          t(locale, 'workspace.agentDetail.skills.title'),
        ),
        list,
      ),
      createElement(
        'div',
        { className: 'skills-tab__right' },
        detailBody,
      ),
    ),
  );
}
