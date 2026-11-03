import { AbstractAgent } from '@ag-ui/client';
import type { BaseEvent, RunAgentInput } from '@ag-ui/client';
import type Database from 'better-sqlite3';
import { Observable } from 'rxjs';
import { ApiFailure } from './api-error.js';
import { readTargetMembersSnapshot } from './agui-snapshot.js';
import { appendMessage } from './messages.js';

/** The one orchestration agentId; a member is never an agentId of its own. */
export const ORCHESTRATION_AGENT_ID = 'allibot';

/**
 * The deterministic echo reply this ticket uses to pin the AG-UI contract.
 * #26 replaces the body with the real orchestration run; the event shape —
 * RUN_STARTED → STATE_SNAPSHOT → one text group per member → RUN_FINISHED —
 * is what this ticket fixes.
 */
const ECHO_PREFIX = 'echo: ';

/** The latest human message in the run input, which the echo answers. */
function lastUserText(input: RunAgentInput): string {
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    const message = input.messages[index];
    if (message?.role === 'user') {
      return typeof message.content === 'string' ? message.content : '';
    }
  }
  return '';
}

function describeFailure(error: unknown): string {
  if (error instanceof ApiFailure) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * The echo answers Agent members only: the owner's own message is already in
 * the thread, and the snapshot's member list deliberately carries every member
 * (the renderer needs the owner's avatar too).
 */
function isAgentMember(db: Database.Database, memberId: string): boolean {
  const row = db.prepare("SELECT kind FROM member WHERE id = ? AND kind = 'agent'").get(memberId);
  return row !== undefined;
}

/**
 * The orchestration agent: one agentId for every target, keyed by threadId.
 * A run resolves the target from `input.threadId`, writes each member reply
 * through the single message write path, and streams the persisted rows as
 * AG-UI text messages whose messageId is the SQLite `message.id`. The events
 * observe the rows; they are not a second source of truth.
 */
export class AllibotAgent extends AbstractAgent {
  constructor(private readonly database: Database.Database) {
    super({ agentId: ORCHESTRATION_AGENT_ID, description: 'allibot 编排 agent' });
  }

  /**
   * `AbstractAgent.clone()` copies the fields it knows about, so the database
   * handle — which every clone needs to keep serving runs — is carried over
   * here rather than lost with the prototype.
   */
  override clone(): AllibotAgent {
    return new AllibotAgent(this.database);
  }

  override run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      let closed = false;
      const emit = (event: BaseEvent): void => {
        if (!closed) {
          subscriber.next(event);
        }
      };
      const finish = (): void => {
        if (!closed) {
          closed = true;
          subscriber.complete();
        }
      };

      emit({
        type: 'RUN_STARTED',
        threadId: input.threadId,
        runId: input.runId,
        input,
      } as BaseEvent);

      try {
        const snapshot = readTargetMembersSnapshot(this.database, input.threadId);
        emit({
          type: 'STATE_SNAPSHOT',
          snapshot: snapshot as unknown as Record<string, unknown>,
        } as BaseEvent);

        const text = lastUserText(input);
        for (const member of snapshot.members) {
          if (!isAgentMember(this.database, member.member_id)) {
            continue;
          }
          const { id } = appendMessage(this.database, {
            targetId: input.threadId,
            kind: 'agent',
            body: `${ECHO_PREFIX}${text}`,
            authorMemberId: member.member_id,
          });
          emit({ type: 'TEXT_MESSAGE_START', messageId: id, role: 'assistant' } as BaseEvent);
          emit({
            type: 'TEXT_MESSAGE_CONTENT',
            messageId: id,
            delta: `${ECHO_PREFIX}${text}`,
          } as BaseEvent);
          emit({ type: 'TEXT_MESSAGE_END', messageId: id } as BaseEvent);
        }

        emit({
          type: 'RUN_FINISHED',
          threadId: input.threadId,
          runId: input.runId,
        } as BaseEvent);
      } catch (error: unknown) {
        emit({
          type: 'RUN_ERROR',
          message: describeFailure(error),
          code: error instanceof ApiFailure ? error.code : 'internal_error',
        } as BaseEvent);
      }
      finish();
    });
  }
}
