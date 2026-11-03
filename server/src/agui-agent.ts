import { AbstractAgent, contentToText } from '@ag-ui/client';
import type { BaseEvent, RunAgentInput, UserMessage } from '@ag-ui/client';
import type Database from 'better-sqlite3';
import { Observable } from 'rxjs';
import { ApiFailure } from './api-error.js';
import { readTargetMembersSnapshot } from './agui-snapshot.js';
import { appendMessageAndDispatch } from './messages.js';
import type { CommittedReply, OrchestrationRuntime } from './rounds.js';

/** The one orchestration agentId; a member is never an agentId of its own. */
export const ORCHESTRATION_AGENT_ID = 'allibot';

/**
 * The orchestration agent: one agentId for every target, keyed by threadId.
 *
 * A run is the live human face of the same orchestration the REST message
 * write and the backend-driven paths use: it writes the new user messages from
 * `input.messages` through the one message write path, and that write drives
 * the rounds its wakes trigger through `dispatchWakes`/`runRound`. The run then
 * observes the committed replies: each is one AG-UI text group whose
 * `messageId` is the SQLite `message.id`. The events observe the rows; they are
 * not a second source of truth.
 *
 * Dedupe basis, so a round never runs twice:
 * - The AG-UI user message id is the client message id. A replayed id writes
 *   nothing (`appendMessage` returns `created: false`) and therefore wakes
 *   nobody; the rounds it already drove are not driven again.
 * - A hydrated user message carries the SQLite `message.id` as its AG-UI id;
 *   the run skips it, so replaying the loaded history never appends rows.
 * - The round itself is only ever started by `dispatchWakes`, with the process
 *   in-flight registry shared with the REST and claim paths.
 *
 * Cancellation (人类中断): the runtime's stop route reaches `abortRun()`; the
 * signal closes the in-flight round with `finished_reason = human-interrupt`
 * and no reply message, starts no further round, and the run ends with the
 * protocol's cancelled outcome.
 */
export class AllibotAgent extends AbstractAgent {
  /** The run this clone is currently serving; `abortRun()` aborts it. */
  private activeRun: AbortController | undefined;

  constructor(
    private readonly database: Database.Database,
    private readonly orchestration: OrchestrationRuntime,
  ) {
    super({ agentId: ORCHESTRATION_AGENT_ID, description: 'allibot 编排 agent' });
  }

  /**
   * `AbstractAgent.clone()` copies the fields it knows about; the database and
   * the orchestration runtime are carried over here so every per-request clone
   * keeps serving runs.
   */
  override clone(): AllibotAgent {
    return new AllibotAgent(this.database, this.orchestration);
  }

  /** The runtime's stop route cancels the run in flight (人类中断). */
  override abortRun(): void {
    this.activeRun?.abort();
  }

  override run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      const controller = new AbortController();
      this.activeRun = controller;
      let closed = false;
      let settled = false;
      const emit = (event: BaseEvent): void => {
        if (!closed) {
          subscriber.next(event);
        }
      };
      const finish = (): void => {
        if (!closed) {
          closed = true;
          settled = true;
          subscriber.complete();
        }
        if (this.activeRun === controller) {
          this.activeRun = undefined;
        }
      };
      const fail = (error: unknown): void => {
        emit({
          type: 'RUN_ERROR',
          message: describeFailure(error),
          code: error instanceof ApiFailure ? error.code : 'internal_error',
        } as BaseEvent);
        finish();
      };
      const cancelled = (): void => {
        emit({
          type: 'RUN_FINISHED',
          threadId: input.threadId,
          runId: input.runId,
          outcome: { type: 'cancelled' },
        } as BaseEvent);
        finish();
      };

      emit({
        type: 'RUN_STARTED',
        threadId: input.threadId,
        runId: input.runId,
        input,
      } as BaseEvent);

      void (async (): Promise<void> => {
        try {
          // Resolving the target is the snapshot read: an unknown, deleted, or
          // unreadable target throws here and closes the run with RUN_ERROR.
          const snapshot = readTargetMembersSnapshot(this.database, input.threadId);
          emit({ type: 'STATE_SNAPSHOT', snapshot } as BaseEvent);

          for (const message of input.messages) {
            if (controller.signal.aborted) {
              break;
            }
            if (message.role !== 'user') {
              continue;
            }
            const body = messageBody(message);
            if (body.length === 0 || isStoredMessage(this.database, input.threadId, message.id)) {
              continue;
            }
            // The one write path the REST message entry uses. A fresh write
            // drives the rounds its wakes trigger; the observer streams each
            // reply the run's own message caused, as its row commits. A replayed
            // client id writes nothing and wakes nobody, so no round re-runs.
            await appendMessageAndDispatch(
              this.database,
              {
                targetId: input.threadId,
                kind: 'human',
                body,
                clientMessageId: message.id,
                attachmentIds: messageAttachmentIds(message),
              },
              this.orchestration,
              {
                signal: controller.signal,
                awaitDeferred: true,
                onReply: (reply: CommittedReply): void => {
                  emit({
                    type: 'TEXT_MESSAGE_START',
                    messageId: reply.id,
                    role: 'assistant',
                    name: reply.authorDisplayName,
                    metadata: {
                      allibot_kind: 'agent',
                      author_member_id: reply.memberId,
                      author_display_name: reply.authorDisplayName,
                      author_avatar_slot: reply.authorAvatarSlot,
                      task_ref: null,
                      task_pointer: null,
                      mentions: [],
                    },
                  } as BaseEvent);
                  emit({
                    type: 'TEXT_MESSAGE_CONTENT',
                    messageId: reply.id,
                    delta: reply.body,
                  } as BaseEvent);
                  emit({ type: 'TEXT_MESSAGE_END', messageId: reply.id } as BaseEvent);
                },
              },
            );
          }

          if (controller.signal.aborted) {
            cancelled();
            return;
          }
          emit({
            type: 'RUN_FINISHED',
            threadId: input.threadId,
            runId: input.runId,
          } as BaseEvent);
          finish();
        } catch (error) {
          fail(error);
        }
      })();

      return () => {
        closed = true;
        // A client that goes away cancels the run's rounds as a human
        // interrupt; a run that already finished must not abort the detached
        // relay rounds its dispatch left to the backend.
        if (!settled) {
          controller.abort();
        }
        if (this.activeRun === controller) {
          this.activeRun = undefined;
        }
      };
    });
  }
}

/**
 * The run input's user messages carry the client message id as their AG-UI
 * id. A hydrated message carries the SQLite `message.id` instead, so it is
 * already stored and must not be appended again.
 */
function isStoredMessage(db: Database.Database, targetId: string, messageId: string): boolean {
  const row = db
    .prepare('SELECT 1 FROM message WHERE target_id = ? AND (id = ? OR client_message_id = ?)')
    .get(targetId, messageId, messageId);
  return row !== undefined;
}

/** The text body a run message is stored with; parts flatten to their text. */
function messageBody(message: UserMessage): string {
  return contentToText(message.content).trim();
}

/**
 * The upload drafts a run message binds. The live face carries them as
 * `metadata.attachment_ids` (the CopilotKit message is the only caravan the
 * run input offers); the shared write path binds them in the message's own
 * transaction, exactly like the REST `attachment_ids` field.
 */
function messageAttachmentIds(message: UserMessage): string[] {
  const value = message.metadata?.['attachment_ids'];
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || id.length === 0)) {
    throw ApiFailure.validation(
      'metadata.attachment_ids must be an array of non-empty strings',
      { field: 'metadata.attachment_ids' },
    );
  }
  return value as string[];
}

/** The readable reason a failed run reports; the row status stays SQLite's. */
function describeFailure(error: unknown): string {
  if (error instanceof ApiFailure) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
