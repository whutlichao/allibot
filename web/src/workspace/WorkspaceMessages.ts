import { t, type Locale, type TaskView, type TargetMemberView } from '@allibot/shared';
import {
  CopilotChatAssistantMessage,
  CopilotChatInput,
  CopilotChatMessageView,
  CopilotChatUserMessage,
  useCopilotChatConfiguration,
  type CopilotChatAssistantMessageProps,
  type CopilotChatInputProps,
  type CopilotChatMessageViewProps,
  type CopilotChatUserMessageProps,
  type Message,
} from '@copilotkit/react-core/v2';
import {
  createContext,
  createElement,
  forwardRef,
  useContext,
  useEffect,
  useState,
  type TextareaHTMLAttributes,
} from 'react';
import { MentionCompletion } from '../components/MentionCompletion.ts';
import { MessageBody } from '../components/MessageBody.ts';
import { Avatar, AVATAR_SLOTS, type AvatarSlot } from '../components/Avatar.ts';
import { readTargetMembers } from '../workspace-actions.ts';
import {
  readMessageMetadata,
  type TargetMembersSnapshot,
} from './message-sync.ts';

/**
 * The workbench's message rendering (D2.4 / D3.2): human and Agent bodies go
 * through `MessageBody` (Markdown, backend mention ranges), while `system`
 * records are event lines. The assistant renderer shows the author of each
 * message by looking its `messageId` up in the row metadata, with the run's
 * `STATE_SNAPSHOT` member map as the name / avatar source.
 *
 * The slot is mounted through `CopilotChatView.messageView`; the v2 API's
 * `assistantMessage` / `userMessage` slots live on `CopilotChatMessageView`,
 * which is what this component renders.
 *
 * Everything here uses createElement rather than JSX: Node's type stripping
 * does not handle JSX, and the component contract tests import this file.
 */

export interface WorkspaceChatContextValue {
  tasks: readonly TaskView[];
  onSelectTarget?: (targetId: string) => void;
  locale: Locale;
  /** The selected DM's peer was soft-deleted; the composer is read-only. */
  archivedDm: boolean;
}

export const WorkspaceChatContext = createContext<WorkspaceChatContextValue>({
  tasks: [],
  locale: 'zh-CN',
  archivedDm: false,
});

/** The run's STATE_SNAPSHOT, scoped to the thread the chat is bound to. */
export const WorkspaceSnapshotContext = createContext<TargetMembersSnapshot | null>(null);

/**
 * `system` rows are records, not assistant speech, but CopilotKit's message
 * view only dispatches assistant / user / reasoning rows. Moving them onto the
 * assistant slot keeps the original order and lets the slot render an event
 * line instead of a conversation bubble.
 */
export function transformWorkspaceMessages(messages: readonly Message[]): Message[] {
  return messages.map((message) =>
    message.role === 'system' ? ({ ...message, role: 'assistant' } as Message) : message,
  );
}

export function WorkspaceMessageView(props: CopilotChatMessageViewProps) {
  return createElement(CopilotChatMessageView, {
    ...props,
    assistantMessage: WorkspaceAssistantMessage as unknown as typeof CopilotChatAssistantMessage,
    userMessage: WorkspaceUserMessage as unknown as typeof CopilotChatUserMessage,
    transformMessages: transformWorkspaceMessages,
  });
}

/** The author facts a renderer shows; the row snapshot wins over the run map. */
export interface MessageAuthorView {
  memberId: string;
  displayName: string;
  avatarSlot: number;
}

/**
 * Resolve one message's author. The row metadata is the durable fact the
 * messageId points at; the STATE_SNAPSHOT map supplies the display name and
 * avatar slot when the run's mapping is newer (the durable id is the join key).
 * A message without either fact renders no author header rather than guessing.
 */
export function resolveMessageAuthor(
  message: Message,
  snapshot: TargetMembersSnapshot | null,
): MessageAuthorView | null {
  const metadata = readMessageMetadata(message);
  if (metadata === null) {
    return null;
  }
  const member = snapshot?.members.find(
    (candidate) => candidate.member_id === metadata.author_member_id,
  );
  return {
    memberId: metadata.author_member_id,
    displayName: member?.display_name ?? metadata.author_display_name,
    avatarSlot: member?.avatar_slot ?? metadata.author_avatar_slot,
  };
}

function avatarSlotOf(value: number): AvatarSlot {
  return AVATAR_SLOTS.includes(value as AvatarSlot) ? (value as AvatarSlot) : AVATAR_SLOTS[0];
}

function messageText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === 'object' && part !== null && 'text' in part
          ? String((part as { text: unknown }).text)
          : '',
      )
      .join('');
  }
  return content === undefined || content === null ? '' : String(content);
}

function authorHeader(author: MessageAuthorView) {
  return createElement(
    'div',
    {
      className: 'workspace-message__author',
      'data-author-member-id': author.memberId,
    },
    createElement(Avatar, {
      slot: avatarSlotOf(author.avatarSlot),
      name: author.displayName,
    }),
    createElement('span', { className: 'workspace-message__author-name' }, author.displayName),
  );
}

/** The task a chip points into; the task target is the thread identity. */
export function taskChipTarget(
  tasks: readonly TaskView[],
  taskId: string,
): string | null {
  return tasks.find((candidate) => candidate.id === taskId)?.target_id ?? null;
}

function taskPointerChip(taskId: string) {
  const context = useContext(WorkspaceChatContext);
  const task = context.tasks.find((candidate) => candidate.id === taskId);
  const target = taskChipTarget(context.tasks, taskId);
  const unread = task?.unread_count ?? 0;
  return createElement(
    'button',
    {
      type: 'button',
      className: 'task-chip',
      'data-action': 'open-task',
      'data-task-pointer': taskId,
      disabled: target === null,
      onClick: () => {
        if (target !== null) {
          context.onSelectTarget?.(target);
        }
      },
    },
    t(context.locale, 'taskBoard.chip.thread'),
    unread > 0
      ? createElement(
          'span',
          { className: 'task-chip__unread', 'data-unread-count': unread },
          t(context.locale, 'taskBoard.chip.unread', { count: unread }),
        )
      : null,
  );
}

function taskRefChip(taskId: string) {
  const context = useContext(WorkspaceChatContext);
  const task = context.tasks.find((candidate) => candidate.id === taskId);
  const target = taskChipTarget(context.tasks, taskId);
  return createElement(
    'button',
    {
      type: 'button',
      className: 'task-chip task-chip--ref',
      'data-action': 'open-task',
      'data-task-ref': taskId,
      disabled: target === null,
      onClick: () => {
        if (target !== null) {
          context.onSelectTarget?.(target);
        }
      },
    },
    t(context.locale, 'taskBoard.chip.taskRef', { title: task?.title ?? taskId }),
  );
}

function messageChips(metadata: {
  task_pointer: string | null;
  task_ref: string | null;
}) {
  if (metadata.task_pointer === null && metadata.task_ref === null) {
    return null;
  }
  return createElement(
    'div',
    { className: 'workspace-message__chips' },
    metadata.task_pointer === null ? null : taskPointerChip(metadata.task_pointer),
    metadata.task_ref === null ? null : taskRefChip(metadata.task_ref),
  );
}

export function WorkspaceAssistantMessage(props: CopilotChatAssistantMessageProps) {
  const message = props.message;
  const snapshot = useContext(WorkspaceSnapshotContext);
  const metadata = readMessageMetadata(message);
  const body = messageText(message.content);

  if (metadata?.allibot_kind === 'system' || (message.role as string) === 'system') {
    return createElement(
      'div',
      {
        className: 'workspace-message workspace-message--event',
        'data-message-id': message.id,
      },
      createElement(MessageBody, { kind: 'system', body }),
      metadata === null ? null : messageChips(metadata),
    );
  }

  const author = resolveMessageAuthor(message, snapshot);
  return createElement(
    'div',
    {
      className: 'workspace-message workspace-message--assistant',
      'data-message-id': message.id,
      'data-author-member-id': author?.memberId ?? '',
    },
    author === null ? null : authorHeader(author),
    createElement(MessageBody, {
      kind: 'agent',
      body,
      mentions: metadata?.mentions ?? [],
    }),
    metadata === null ? null : messageChips(metadata),
  );
}

export function WorkspaceUserMessage(props: CopilotChatUserMessageProps) {
  const message = props.message;
  const snapshot = useContext(WorkspaceSnapshotContext);
  const metadata = readMessageMetadata(message);
  const author = resolveMessageAuthor(message, snapshot);
  return createElement(
    'div',
    {
      className: 'workspace-message workspace-message--user',
      'data-message-id': message.id,
      'data-author-member-id': author?.memberId ?? '',
    },
    author === null ? null : authorHeader(author),
    createElement(MessageBody, {
      kind: 'human',
      body: messageText(message.content),
      mentions: metadata?.mentions ?? [],
    }),
    metadata === null ? null : messageChips(metadata),
  );
}

/** Report where the caret sits after an edit, for the completion query. */
const CaretContext = createContext<(caret: number) => void>(() => undefined);

const CompletionTextArea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function CompletionTextArea(props, ref) {
  const reportCaret = useContext(CaretContext);
  const report = (event: { currentTarget: HTMLTextAreaElement }): void => {
    reportCaret(event.currentTarget.selectionStart ?? 0);
  };
  return createElement(CopilotChatInput.TextArea, {
    ...props,
    ref,
    onSelect: (event) => {
      props.onSelect?.(event);
      report(event);
    },
    onKeyUp: (event) => {
      props.onKeyUp?.(event);
      report(event);
    },
    onClick: (event) => {
      props.onClick?.(event);
      report(event);
    },
  });
});

export interface WorkspaceComposerViewProps {
  inputProps: CopilotChatInputProps;
  members: readonly TargetMemberView[];
  text: string;
  caret: number;
  archivedDm: boolean;
  locale: Locale;
  onChange?: (value: string) => void;
  onCaretChange?: (caret: number) => void;
}

/**
 * The composer with mention completion: candidate agents come from the target
 * member reading, and the list opens only while an `@` query is active (the
 * parser's literal left boundary). An archived DM (the peer was soft-deleted)
 * renders a read-only notice instead of the input, so there is no send entry
 * to reach the backend's 400.
 */
export function WorkspaceComposerView({
  inputProps,
  members,
  text,
  caret,
  archivedDm,
  locale,
  onChange,
  onCaretChange,
}: WorkspaceComposerViewProps) {
  if (archivedDm) {
    return createElement(
      'div',
      {
        className: 'workspace-composer workspace-composer--readonly',
        'data-readonly': 'true',
        role: 'note',
      },
      t(locale, 'workspace.composer.archivedDm'),
    );
  }

  return createElement(
    'div',
    { className: 'workspace-composer' },
    createElement(
      CaretContext.Provider,
      { value: onCaretChange ?? (() => undefined) },
      createElement(CopilotChatInput, {
        ...inputProps,
        value: text,
        onChange,
        textArea: CompletionTextArea,
      }),
    ),
    createElement(MentionCompletion, {
      members,
      text,
      caret,
      locale,
      onSelect: (selection) => {
        onChange?.(selection.value);
        onCaretChange?.(selection.caret);
      },
    }),
  );
}

/** The live composer: it fetches the current target's members and owns the text. */
export function WorkspaceComposer(props: CopilotChatInputProps) {
  const configuration = useCopilotChatConfiguration();
  const context = useContext(WorkspaceChatContext);
  const threadId = configuration?.threadId ?? null;
  const [members, setMembers] = useState<TargetMemberView[]>([]);
  const [text, setText] = useState(props.value ?? '');
  const [caret, setCaret] = useState((props.value ?? '').length);

  useEffect(() => {
    setText(props.value ?? '');
    setCaret((props.value ?? '').length);
  }, [props.value]);

  useEffect(() => {
    if (threadId === null) {
      setMembers([]);
      return;
    }
    let cancelled = false;
    readTargetMembers(fetch, threadId)
      .then((rows) => {
        if (!cancelled) {
          setMembers(rows);
        }
      })
      .catch((error: unknown) => {
        console.error('target member read failed', error);
      });
    return () => {
      cancelled = true;
    };
  }, [threadId]);

  function change(value: string): void {
    setText(value);
    setCaret(value.length);
    props.onChange?.(value);
  }

  return createElement(WorkspaceComposerView, {
    inputProps: { ...props, onChange: change },
    members,
    text,
    caret,
    archivedDm: context.archivedDm,
    locale: context.locale,
    onChange: change,
    onCaretChange: setCaret,
  });
}
