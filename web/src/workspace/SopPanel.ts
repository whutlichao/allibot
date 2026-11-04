import {
  SOP_MAX_ATTEMPTS,
  SOP_MAX_STEPS,
  SOP_RUN_PHASES,
  t,
  type ChannelView,
  type Locale,
  type SopDefinitionCreate,
  type SopDefinitionView,
  type SopRunView,
  type SopStepDefinition,
  type TargetMemberView,
} from '@allibot/shared';
import { createElement, useState, type ReactNode } from 'react';
import {
  hasActiveSopRun,
  readSopRunState,
  sopPhaseLabel,
  sopWaitingOnLabel,
  SOP_RUNS_PAGE_LIMIT,
} from './sops.ts';

type DraftStep = SopStepDefinition;

export interface SopPanelProps {
  /** The selected channel; a SOP exists only inside a channel. */
  channel: ChannelView;
  /** The channel's definitions, already read from `GET /api/sops`. */
  definitions: readonly SopDefinitionView[];
  /** The newest runs per definition id, already read from the run snapshot. */
  runsByDefinition?: Readonly<Record<string, readonly SopRunView[]>>;
  /** The channel's member table; the two role selects read the Agent rows. */
  members?: readonly TargetMemberView[];
  locale: Locale;
  /** The host's create write; the panel never fetches or writes itself. */
  onCreate?: (input: SopDefinitionCreate) => void | Promise<void>;
  /** The host's start write; the returned pending run is rendered by the host. */
  onStart?: (definitionId: string) => void | Promise<void>;
  /** The fold's summary already names the section, so the inner title yields. */
  showTitle?: boolean;
}

function emptyStep(): DraftStep {
  return {
    title: '',
    description: '',
    executor_member_id: '',
    verifier_member_id: '',
    max_attempts: 1,
  };
}

/**
 * SOP 定义 / 启动区 (#41 / D4.2): one immutable channel-scoped step list, its
 * start button and the newest runs as a read-only reading. The form and the
 * list both go through the host's one create / start callback; the panel never
 * fetches, never writes optimistically and never renders a run as a message or
 * a task row.
 *
 * 这里用 createElement 而不是 JSX：Node 的类型剥离不处理 JSX，
 * 组件级 SSR 契约测试需要直接 import 本文件。
 */
export function SopPanel({
  channel,
  definitions,
  runsByDefinition,
  members,
  locale,
  onCreate,
  onStart,
  showTitle = true,
}: SopPanelProps) {
  const [name, setName] = useState('');
  const [steps, setSteps] = useState<DraftStep[]>(() => [emptyStep()]);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [startingId, setStartingId] = useState<string | null>(null);
  const [startFailed, setStartFailed] = useState(false);

  const writable = channel.archived_at === null;
  const agents = (members ?? []).filter((member) => member.kind === 'agent');
  const names = new Map((members ?? []).map((member) => [member.id, member.display_name]));

  function updateStep(index: number, patch: Partial<DraftStep>): void {
    setSteps((current) =>
      current.map((step, stepIndex) => (stepIndex === index ? { ...step, ...patch } : step)),
    );
  }

  function submit(event?: { preventDefault?: () => void }): void {
    event?.preventDefault?.();
    if (!writable || saving || onCreate === undefined) {
      return;
    }
    setSaving(true);
    setSaveFailed(false);
    void Promise.resolve(
      onCreate({ channel_id: channel.id, name: name.trim(), steps }),
    )
      .then(() => {
        setSaving(false);
        setName('');
        setSteps([emptyStep()]);
      })
      .catch(() => {
        setSaving(false);
        setSaveFailed(true);
      });
  }

  function start(definitionId: string): void {
    if (!writable || startingId !== null || onStart === undefined) {
      return;
    }
    setStartingId(definitionId);
    setStartFailed(false);
    void Promise.resolve(onStart(definitionId))
      .then(() => setStartingId(null))
      .catch(() => {
        setStartingId(null);
        setStartFailed(true);
      });
  }

  function agentOptions(): ReactNode[] {
    return [
      createElement('option', { key: 'empty', value: '' }, '—'),
      ...agents.map((agent) =>
        createElement('option', { key: agent.id, value: agent.id }, agent.display_name),
      ),
    ];
  }

  function field(
    index: number,
    key: keyof DraftStep,
    label: string,
    control: ReactNode,
  ): ReactNode {
    return createElement(
      'label',
      { className: 'sop-panel__field', key: `${index}-${key}` },
      createElement('span', { className: 'sop-panel__label' }, label),
      control,
    );
  }

  const form = createElement(
    'form',
    {
      className: 'sop-panel__form',
      'data-sop-form': '',
      onSubmit: submit,
    },
    createElement('h4', { className: 'sop-panel__form-title' }, t(locale, 'workspace.sop.form.title')),
    createElement(
      'label',
      { className: 'sop-panel__field' },
      createElement(
        'span',
        { className: 'sop-panel__label' },
        t(locale, 'workspace.sop.form.name'),
      ),
      createElement('input', {
        type: 'text',
        className: 'sop-panel__input',
        'data-sop-field': 'name',
        value: name,
        disabled: !writable || saving,
        onChange: (event: { target: { value: string } }) => setName(event.target.value),
      }),
    ),
    ...steps.map((step, index) =>
      createElement(
        'fieldset',
        {
          key: index,
          className: 'sop-panel__step',
          'data-sop-step-index': index,
        },
        createElement(
          'legend',
          { className: 'sop-panel__legend' },
          t(locale, 'workspace.sop.form.step', { index: index + 1 }),
        ),
        field(
          index,
          'title',
          t(locale, 'workspace.sop.form.stepTitle'),
          createElement('input', {
            type: 'text',
            className: 'sop-panel__input',
            'data-sop-step-field': 'title',
            value: step.title,
            disabled: !writable || saving,
            onChange: (event: { target: { value: string } }) =>
              updateStep(index, { title: event.target.value }),
          }),
        ),
        field(
          index,
          'description',
          t(locale, 'workspace.sop.form.stepDescription'),
          createElement('input', {
            type: 'text',
            className: 'sop-panel__input',
            'data-sop-step-field': 'description',
            value: step.description,
            disabled: !writable || saving,
            onChange: (event: { target: { value: string } }) =>
              updateStep(index, { description: event.target.value }),
          }),
        ),
        field(
          index,
          'executor_member_id',
          t(locale, 'workspace.sop.form.executor'),
          createElement(
            'select',
            {
              className: 'sop-panel__select',
              'data-sop-step-field': 'executor_member_id',
              value: step.executor_member_id,
              disabled: !writable || saving,
              onChange: (event: { target: { value: string } }) =>
                updateStep(index, { executor_member_id: event.target.value }),
            },
            ...agentOptions(),
          ),
        ),
        field(
          index,
          'verifier_member_id',
          t(locale, 'workspace.sop.form.verifier'),
          createElement(
            'select',
            {
              className: 'sop-panel__select',
              'data-sop-step-field': 'verifier_member_id',
              value: step.verifier_member_id,
              disabled: !writable || saving,
              onChange: (event: { target: { value: string } }) =>
                updateStep(index, { verifier_member_id: event.target.value }),
            },
            ...agentOptions(),
          ),
        ),
        field(
          index,
          'max_attempts',
          t(locale, 'workspace.sop.form.maxAttempts'),
          createElement('input', {
            type: 'number',
            min: 1,
            max: SOP_MAX_ATTEMPTS,
            className: 'sop-panel__input sop-panel__attempts',
            'data-sop-step-field': 'max_attempts',
            value: step.max_attempts,
            disabled: !writable || saving,
            onChange: (event: { target: { value: string } }) =>
              updateStep(index, { max_attempts: Number(event.target.value) }),
          }),
        ),
        steps.length > 1
          ? createElement(
              'button',
              {
                type: 'button',
                className: 'sop-panel__action',
                'data-action': 'sop-remove-step',
                disabled: !writable || saving,
                onClick: () =>
                  setSteps((current) => current.filter((_step, stepIndex) => stepIndex !== index)),
              },
              t(locale, 'workspace.sop.form.removeStep'),
            )
          : null,
      ),
    ),
    createElement(
      'button',
      {
        type: 'button',
        className: 'sop-panel__action',
        'data-action': 'sop-add-step',
        disabled: !writable || saving || steps.length >= SOP_MAX_STEPS,
        onClick: () => setSteps((current) => [...current, emptyStep()]),
      },
      t(locale, 'workspace.sop.form.addStep'),
    ),
    members === undefined
      ? createElement(
          'p',
          { className: 'sop-panel__hint' },
          t(locale, 'workspace.sop.form.agentsPending'),
        )
      : null,
    createElement(
      'button',
      {
        type: 'submit',
        className: 'sop-panel__submit',
        'data-action': 'sop-create',
        disabled: !writable || saving,
      },
      t(locale, 'workspace.sop.form.submit'),
    ),
    saveFailed
      ? createElement(
          'p',
          { className: 'sop-panel__error', role: 'alert' },
          t(locale, 'workspace.sop.form.saveFailed'),
        )
      : null,
  );

  function renderStep(step: SopStepDefinition, index: number): ReactNode {
    return createElement(
      'li',
      { key: `${step.title}-${index}`, className: 'sop-panel__definition-step' },
      createElement('span', { className: 'sop-panel__step-title' }, step.title),
      createElement(
        'span',
        { className: 'sop-panel__step-roles' },
        `${t(locale, 'workspace.sop.form.executor')}：${names.get(step.executor_member_id) ?? step.executor_member_id}`,
        ` → ${t(locale, 'workspace.sop.form.verifier')}：${names.get(step.verifier_member_id) ?? step.verifier_member_id}`,
        ` · ${t(locale, 'workspace.sop.form.maxAttempts')}：${step.max_attempts}`,
      ),
    );
  }

  function renderRun(run: SopRunView): ReactNode {
    const state = readSopRunState(run.state);
    const waiting = sopWaitingOnLabel(locale, run.waiting_on);
    const phaseStrip = createElement(
      'div',
      { className: 'sop-panel__phase-strip', 'data-sop-phases': '' },
      createElement(
        'span',
        { className: 'sop-panel__phase-strip-label' },
        t(locale, 'workspace.sop.runs.phaseStrip'),
      ),
      createElement(
        'ol',
        { className: 'sop-panel__phases' },
        ...SOP_RUN_PHASES.map((phase) =>
          createElement(
            'li',
            {
              key: phase,
              className:
                phase === run.phase
                  ? 'sop-panel__phase sop-panel__phase--active'
                  : 'sop-panel__phase',
              'data-sop-phase': phase,
              'data-sop-phase-active': phase === run.phase ? 'true' : 'false',
            },
            sopPhaseLabel(locale, phase),
          ),
        ),
      ),
    );
    const details = createElement(
      'div',
      { className: 'sop-panel__run-details' },
      createElement(
        'span',
        { className: 'sop-panel__run-detail' },
        `${t(locale, 'workspace.sop.runs.currentStep')}：${run.current_step}`,
      ),
      createElement(
        'span',
        { className: 'sop-panel__run-detail' },
        `${t(locale, 'workspace.sop.runs.attempt')}：${run.attempt}`,
      ),
      createElement(
        'span',
        { className: 'sop-panel__run-detail' },
        `${t(locale, 'workspace.sop.runs.waitingOn')}：${waiting}`,
      ),
      createElement(
        'span',
        { className: 'sop-panel__run-detail' },
        `${t(locale, 'workspace.sop.runs.startedAt')}：${run.started_at}`,
      ),
      createElement(
        'span',
        { className: 'sop-panel__run-detail' },
        `${t(locale, 'workspace.sop.runs.finishedAt')}：${run.finished_at ?? '—'}`,
      ),
    );
    const excerpts = createElement(
      'ul',
      { className: 'sop-panel__run-steps', 'data-sop-run-steps': '' },
      ...state.steps.map((step) =>
        createElement(
          'li',
          {
            key: step.index,
            className: 'sop-panel__run-step',
            'data-sop-step-index': step.index,
            'data-sop-step-verdict': step.verifier_verdict ?? 'none',
          },
          createElement(
            'div',
            { className: 'sop-panel__run-step-head' },
            createElement(
              'strong',
              { className: 'sop-panel__run-step-title' },
              `${step.index + 1}. ${step.title}`,
            ),
            createElement(
              'span',
              { className: 'sop-panel__run-step-attempts' },
              `${t(locale, 'workspace.sop.runs.attempt')}：${step.attempts}`,
            ),
          ),
          step.executor_excerpt === null
            ? null
            : createElement(
                'p',
                {
                  className: 'sop-panel__run-excerpt',
                  'data-sop-executor-excerpt': '',
                },
                `${t(locale, 'workspace.sop.runs.executorExcerpt')}：${step.executor_excerpt}`,
              ),
          step.verifier_excerpt === null
            ? null
            : createElement(
                'p',
                {
                  className: 'sop-panel__run-excerpt',
                  'data-sop-verifier-excerpt': '',
                },
                `${t(locale, 'workspace.sop.runs.verifierExcerpt')}：${step.verifier_excerpt}`,
              ),
        ),
      ),
    );
    return createElement(
      'li',
      {
        key: run.id,
        className: 'sop-panel__run',
        'data-sop-run-id': run.id,
        'data-sop-run-phase': run.phase,
        'data-sop-run-current-step': run.current_step,
        'data-sop-run-attempt': run.attempt,
        'data-sop-run-waiting-on': run.waiting_on ?? 'none',
      },
      phaseStrip,
      createElement(
        'div',
        { className: 'sop-panel__run-head' },
        createElement(
          'span',
          { className: 'sop-panel__run-phase' },
          sopPhaseLabel(locale, run.phase),
        ),
      ),
      details,
      state.steps.length === 0 ? null : excerpts,
      state.error === null
        ? null
        : createElement(
            'p',
            { className: 'sop-panel__run-error', role: 'alert' },
            `${t(locale, 'workspace.sop.runs.error')}：${state.error}`,
          ),
    );
  }

  function renderDefinition(definition: SopDefinitionView): ReactNode {
    const runs = (runsByDefinition?.[definition.id] ?? []).slice(0, SOP_RUNS_PAGE_LIMIT);
    const active = hasActiveSopRun(runs);
    return createElement(
      'li',
      {
        key: definition.id,
        className: 'sop-panel__definition',
        'data-sop-definition-id': definition.id,
        'data-sop-definition-name': definition.name,
      },
      createElement(
        'div',
        { className: 'sop-panel__definition-head' },
        createElement('strong', { className: 'sop-panel__definition-name' }, definition.name),
        createElement(
          'button',
          {
            type: 'button',
            className: 'sop-panel__start',
            'data-action': 'sop-start',
            'data-sop-start-id': definition.id,
            disabled: !writable || active || startingId !== null,
            onClick: () => start(definition.id),
          },
          t(locale, 'workspace.sop.start'),
        ),
      ),
      createElement(
        'ol',
        { className: 'sop-panel__steps' },
        ...definition.steps.map(renderStep),
      ),
      createElement(
        'div',
        { className: 'sop-panel__runs', 'data-sop-runs': '' },
        createElement(
          'h4',
          { className: 'sop-panel__runs-title' },
          t(locale, 'workspace.sop.runs.title'),
        ),
        runs.length === 0
          ? createElement(
              'p',
              { className: 'sop-panel__empty' },
              t(locale, 'workspace.sop.runs.empty'),
            )
          : createElement('ul', { className: 'sop-panel__run-list' }, ...runs.map(renderRun)),
      ),
    );
  }

  return createElement(
    'section',
    {
      className: 'sop-panel',
      'data-sop-panel': '',
      'data-sop-channel-id': channel.id,
      'data-sop-writable': writable ? 'true' : 'false',
      'aria-label': t(locale, 'workspace.sop.title'),
    },
    showTitle
      ? createElement(
          'h3',
          { className: 'sop-panel__title' },
          t(locale, 'workspace.sop.title'),
        )
      : null,
    writable
      ? null
      : createElement(
          'p',
          { className: 'sop-panel__hint', role: 'status' },
          t(locale, 'workspace.sop.archived'),
        ),
    form,
    definitions.length === 0
      ? createElement(
          'p',
          { className: 'sop-panel__empty' },
          t(locale, 'workspace.sop.empty'),
        )
      : null,
    createElement(
      'ul',
      { className: 'sop-panel__definitions', 'data-sop-definitions': '' },
      ...definitions.map(renderDefinition),
    ),
    startFailed
      ? createElement(
          'p',
          { className: 'sop-panel__error', role: 'alert' },
          t(locale, 'workspace.sop.form.startFailed'),
        )
      : null,
  );
}
