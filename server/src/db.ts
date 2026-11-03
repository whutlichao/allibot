import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { appendMigrationRecord } from './audit.js';
import { createDataDirBackup } from './backup.js';
import { databasePath } from './data-dir.js';
import { LOCK_FILENAME } from './lock.js';

export const SCHEMA_VERSION = 13;

export interface MigrationStep {
  readonly to: number;
  apply: (db: Database.Database) => void;
}

/**
 * The owner row seeded by this migration. It is a write-path invariant of the
 * migration itself: the empty database always has exactly one human member,
 * and no HTTP route creates it.
 */
const OWNER_DISPLAY_NAME = '我';
const OWNER_AVATAR_SLOT = 0;

/**
 * The production step chain. Every future schema change appends exactly one
 * step at the tail with the next strict +1 number; the baseline step creates
 * schema_meta. Test-only fixtures pass their own appended step instead of
 * changing this chain.
 */
export const MIGRATION_STEPS: readonly MigrationStep[] = [
  {
    to: 1,
    apply(db) {
      db.exec('CREATE TABLE schema_meta (schema_version INTEGER NOT NULL)');
      db.prepare('INSERT INTO schema_meta (schema_version) VALUES (?)').run(1);
    },
  },
  {
    to: 2,
    apply(db) {
      db.exec(`
        CREATE TABLE member (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL CHECK (kind IN ('owner', 'agent')),
          display_name TEXT NOT NULL,
          avatar_slot INTEGER NOT NULL CHECK (avatar_slot BETWEEN 0 AND 4),
          deleted_at TEXT,
          created_at TEXT NOT NULL
        );

        -- The owner is the single human row; a fresh database has exactly one.
        CREATE UNIQUE INDEX member_single_owner ON member (kind) WHERE kind = 'owner';

        CREATE TABLE agent_config (
          member_id TEXT PRIMARY KEY REFERENCES member (id),
          role TEXT NOT NULL DEFAULT '',
          model TEXT,
          system_prompt TEXT NOT NULL DEFAULT '',
          enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
          context_window INTEGER NOT NULL CHECK (context_window > 0),
          compression_threshold REAL NOT NULL CHECK (
            compression_threshold > 0 AND compression_threshold <= 1
          ),
          max_iterations INTEGER NOT NULL CHECK (max_iterations > 0),
          auto_claim INTEGER NOT NULL DEFAULT 1 CHECK (auto_claim IN (0, 1))
        );
      `);
      db.prepare(
        `INSERT INTO member (id, kind, display_name, avatar_slot, deleted_at, created_at)
         VALUES (?, 'owner', ?, ?, NULL, ?)`,
      ).run(randomUUID(), OWNER_DISPLAY_NAME, OWNER_AVATAR_SLOT, new Date().toISOString());
    },
  },
  {
    to: 3,
    apply(db) {
      db.exec(`
        CREATE TABLE channel (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          mode TEXT NOT NULL CHECK (mode IN ('autonomous')),
          response_budget_limit INTEGER NOT NULL DEFAULT 3 CHECK (response_budget_limit IN (3, 5, 10)),
          archived_at TEXT,
          deleted_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        -- target is the scope key for messages, read positions, response budgets
        -- and round results. A channel-type target is a shadow row reusing
        -- channel.id: target.id == channel.id and kind = 'channel'.
        CREATE TABLE target (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL CHECK (kind IN ('channel', 'dm', 'task'))
        );

        -- The single membership ledger for every target kind. Channel members
        -- are its rows read on a channel-type target.
        CREATE TABLE target_member (
          target_id TEXT NOT NULL REFERENCES target (id),
          member_id TEXT NOT NULL REFERENCES member (id),
          PRIMARY KEY (target_id, member_id)
        );
      `);
    },
  },
  {
    to: 4,
    apply(db) {
      db.exec(`
        -- A message is one permanent record inside a target. It is append-only:
        -- there is no code path that updates or deletes one, and the triggers
        -- below make the database the backstop. seq is the target-scoped
        -- monotonic number assigned by the single writer as MAX(seq) + 1.
        CREATE TABLE message (
          id TEXT PRIMARY KEY,
          target_id TEXT NOT NULL REFERENCES target (id),
          seq INTEGER NOT NULL CHECK (seq > 0),
          kind TEXT NOT NULL CHECK (kind IN ('human', 'agent', 'system')),
          author_member_id TEXT NOT NULL REFERENCES member (id),
          -- The author metadata is a snapshot taken at write time: renaming a
          -- member later must not rewrite history, and a soft-deleted author
          -- still renders.
          author_display_name TEXT NOT NULL,
          author_avatar_slot INTEGER NOT NULL CHECK (author_avatar_slot BETWEEN 0 AND 4),
          body TEXT NOT NULL,
          created_at TEXT NOT NULL,
          task_ref TEXT,
          task_pointer TEXT,
          client_message_id TEXT,
          UNIQUE (target_id, seq)
        );

        -- The client message id is the idempotency key shared with the AG-UI
        -- run path: one target never holds two rows for the same client id.
        CREATE UNIQUE INDEX message_client_message_id
          ON message (target_id, client_message_id)
          WHERE client_message_id IS NOT NULL;

        -- Mention ranges are a write-time snapshot: start / end are UTF-16
        -- code-unit offsets into body, and renaming a member never re-runs the
        -- parser over history.
        CREATE TABLE message_mention (
          message_id TEXT NOT NULL REFERENCES message (id),
          member_id TEXT NOT NULL REFERENCES member (id),
          start INTEGER NOT NULL CHECK (start >= 0),
          "end" INTEGER NOT NULL CHECK ("end" > start),
          PRIMARY KEY (message_id, start)
        );

        CREATE TRIGGER message_append_only_update
        BEFORE UPDATE ON message
        BEGIN
          SELECT RAISE(ABORT, 'message is append-only: UPDATE is not allowed');
        END;

        CREATE TRIGGER message_append_only_delete
        BEFORE DELETE ON message
        BEGIN
          SELECT RAISE(ABORT, 'message is append-only: DELETE is not allowed');
        END;
      `);
    },
  },
  {
    to: 5,
    apply(db) {
      db.exec(`
        -- An attachment is the metadata of one object that rides with a
        -- message. The bytes live in the data directory under attachments/,
        -- never in this file. message_id is the binding: NULL is an upload
        -- draft that no read path exposes, and the message write path sets it
        -- inside its own transaction. storage_path is an opaque name chosen by
        -- the server, so a user filename never decides where bytes land.
        CREATE TABLE attachment (
          id TEXT PRIMARY KEY,
          message_id TEXT REFERENCES message (id),
          filename TEXT NOT NULL,
          mime TEXT NOT NULL,
          size INTEGER NOT NULL CHECK (size >= 0),
          storage_path TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL
        );

        -- One message may carry several attachments; the binding lookup is by
        -- message, so it gets its own index.
        CREATE INDEX attachment_message ON attachment (message_id);

        -- Attachments are immutable like messages: binding is the one allowed
        -- state change, so the triggers allow exactly the NULL -> message_id
        -- transition and refuse everything else. There is no delete path.
        CREATE TRIGGER attachment_immutable_update
        BEFORE UPDATE ON attachment
        WHEN NOT (
          OLD.message_id IS NULL
          AND NEW.message_id IS NOT NULL
          AND NEW.id IS OLD.id
          AND NEW.filename IS OLD.filename
          AND NEW.mime IS OLD.mime
          AND NEW.size IS OLD.size
          AND NEW.storage_path IS OLD.storage_path
          AND NEW.created_at IS OLD.created_at
        )
        BEGIN
          SELECT RAISE(ABORT, 'attachment is immutable: only binding to a message is allowed');
        END;

        CREATE TRIGGER attachment_immutable_delete
        BEFORE DELETE ON attachment
        BEGIN
          SELECT RAISE(ABORT, 'attachment is immutable: DELETE is not allowed');
        END;
      `);
    },
  },
  {
    // The attachment ticket merged ahead of this one as version 5, so the
    // workspace settings land at 6; the chain stays a strict +1 sequence.
    to: 6,
    apply(db) {
      db.exec(`
        -- The workspace settings are exactly three config values (locale,
        -- message density, theme). The key check keeps this from becoming a
        -- general key-value store, and the value check keeps every setting a
        -- non-empty string. A value's allowed set is enforced by the write
        -- path, so adding a choice is not a schema change.
        CREATE TABLE setting (
          key TEXT PRIMARY KEY CHECK (key IN ('locale', 'density', 'theme')),
          value TEXT NOT NULL CHECK (length(value) > 0)
        );
      `);
      const insert = db.prepare('INSERT INTO setting (key, value) VALUES (?, ?)');
      insert.run('locale', 'zh-CN');
      insert.run('density', 'comfortable');
      insert.run('theme', 'system');
    },
  },
  {
    // The settings ticket merged ahead of this one as version 6, so the round
    // outcomes land at 7; the chain stays a strict +1 sequence.
    to: 7,
    apply(db) {
      db.exec(`
        -- A round outcome is the processing conclusion of one Agent round: it
        -- is the forensic record of "why did it not speak", kept at the same
        -- level as messages. It is append-only, like a message: there is no
        -- code path that updates or deletes one, and the triggers below make
        -- the database the backstop.
        --
        -- status is the six-word vocabulary of the glossary. This ticket
        -- produces replied / ignored / failed / merged only; budget-exhausted
        -- and silent belong to later tickets and are already in the CHECK so
        -- the table shape never has to change for them.
        --
        -- budget_consumed is a row-level marker ("this round was delivered by
        -- a counted agent-to-agent hop"), not a hop counter; the hop count's
        -- single source of truth is target_budget.used. merged marks the one
        -- row that folds a repeated wake into an in-flight round.
        CREATE TABLE round_outcome (
          id TEXT PRIMARY KEY,
          member_id TEXT NOT NULL REFERENCES member (id),
          target_id TEXT NOT NULL REFERENCES target (id),
          base_seq INTEGER NOT NULL CHECK (base_seq > 0),
          status TEXT NOT NULL CHECK (
            status IN ('replied', 'ignored', 'failed', 'merged', 'budget-exhausted', 'silent')
          ),
          reason TEXT NOT NULL DEFAULT '',
          finished_reason TEXT,
          started_at TEXT NOT NULL,
          finished_at TEXT NOT NULL,
          budget_consumed INTEGER NOT NULL DEFAULT 0 CHECK (budget_consumed IN (0, 1)),
          merged INTEGER NOT NULL DEFAULT 0 CHECK (merged IN (0, 1))
        );

        -- The read paths ask "the outcomes of this target" and "the latest
        -- outcome of this member"; both get their own index.
        CREATE INDEX round_outcome_target ON round_outcome (target_id, id);
        CREATE INDEX round_outcome_member ON round_outcome (member_id, id);

        CREATE TRIGGER round_outcome_append_only_update
        BEFORE UPDATE ON round_outcome
        BEGIN
          SELECT RAISE(ABORT, 'round_outcome is append-only: UPDATE is not allowed');
        END;

        CREATE TRIGGER round_outcome_append_only_delete
        BEFORE DELETE ON round_outcome
        BEGIN
          SELECT RAISE(ABORT, 'round_outcome is append-only: DELETE is not allowed');
        END;
      `);
    },
  },
  {
    // The tasks ticket merged after the round-outcome step; it lands as the
    // next strict +1 of the chain.
    to: 8,
    apply(db) {
      db.exec(`
        -- A task is a work item that belongs to exactly one channel and owns
        -- its own task-type target (the task thread). The task row is mutable
        -- (title, status, assignee); its messages stay append-only. The task
        -- never moves across channels, so the target cannot be rewritten and
        -- a task row is never deleted: the five-state status expresses its
        -- lifecycle instead.
        CREATE TABLE task (
          id TEXT PRIMARY KEY,
          channel_id TEXT NOT NULL REFERENCES channel (id),
          target_id TEXT NOT NULL REFERENCES target (id),
          title TEXT NOT NULL CHECK (length(title) > 0),
          status TEXT NOT NULL CHECK (
            status IN ('todo', 'in_progress', 'in_review', 'done', 'closed')
          ),
          assignee_member_id TEXT REFERENCES member (id),
          claimed_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (target_id)
        );

        -- The board reads the tasks of a channel; the target lookup is the
        -- detail path.
        CREATE INDEX task_channel ON task (channel_id, created_at);

        -- A task points at a task-type target and nowhere else. Column
        -- references cannot express a join, so the trigger is the backstop the
        -- spec requires for the pointer guard's siblings.
        CREATE TRIGGER task_target_must_be_task_kind
        BEFORE INSERT ON task
        WHEN (SELECT kind FROM target WHERE id = NEW.target_id) IS NOT 'task'
        BEGIN
          SELECT RAISE(ABORT, 'task.target_id must reference a task-type target');
        END;

        -- A task belongs to exactly one channel for its whole life: a change
        -- that would move it is a bug, not a state transition.
        CREATE TRIGGER task_scope_is_fixed
        BEFORE UPDATE OF channel_id, target_id ON task
        WHEN NEW.channel_id IS NOT OLD.channel_id OR NEW.target_id IS NOT OLD.target_id
        BEGIN
          SELECT RAISE(ABORT, 'task must stay in its channel and target');
        END;

        CREATE TRIGGER task_no_delete
        BEFORE DELETE ON task
        BEGIN
          SELECT RAISE(ABORT, 'task rows are not deleted: close the task instead');
        END;

        -- A task pointer is a channel system message that points into its own
        -- task thread. At most one pointer per task (partial unique index
        -- below), and the trigger refuses any row that is not a system message
        -- on the channel that owns the task. Client-submitted messages never
        -- carry the field: the human-face parser rejects it as an unknown
        -- field.
        CREATE UNIQUE INDEX message_task_pointer_unique
          ON message (task_pointer)
          WHERE task_pointer IS NOT NULL;

        CREATE TRIGGER message_task_pointer_guard
        BEFORE INSERT ON message
        WHEN NEW.task_pointer IS NOT NULL AND (
          NEW.kind IS NOT 'system'
          OR NOT EXISTS (
            SELECT 1
              FROM target t
              JOIN task k ON k.channel_id = t.id
             WHERE t.id = NEW.target_id
               AND t.kind = 'channel'
               AND k.id = NEW.task_pointer
          )
        )
        BEGIN
          SELECT RAISE(ABORT, 'task_pointer must be a system message on the channel that owns the task');
        END;
      `);
    },
  },
  {
    // Long-term memory lands here as the next strict +1 of the chain (its
    // ticket's plan said v9; the tasks ticket merged as v8 ahead of it).
    to: 9,
    apply(db) {
      db.exec(`
        -- Long-term memory is a member-level collection of memory cards
        -- (ADR 0005): one logical set per member, not split by target, project
        -- or session, so cross-target recall is a construction fact. A card is
        -- a deterministic digest of one round — the triggering message excerpt,
        -- this member's reply excerpt and the task context when there is one —
        -- so its content and keywords are written by the orchestrator, never by
        -- a model.
        --
        -- Unlike a message, a card may be revised: memory is not a second copy
        -- of the append-only message log. source_message_id names the reply
        -- message the card was distilled from; an ignored or failed round has
        -- no reply, so that column is nullable while the target is not.
        --
        -- keywords holds the deterministic tokenizer's extraction as a JSON
        -- array of strings. It is TEXT because retrieval is keyword matching
        -- (no embedding, no vector column, no second index).
        CREATE TABLE agent_memory (
          id TEXT PRIMARY KEY,
          member_id TEXT NOT NULL REFERENCES member (id),
          content TEXT NOT NULL CHECK (length(content) > 0),
          keywords TEXT NOT NULL CHECK (length(keywords) > 0),
          source_target_id TEXT NOT NULL REFERENCES target (id),
          source_message_id TEXT REFERENCES message (id),
          created_at TEXT NOT NULL
        );

        -- Recall reads one member's cards, freshest first, with no target or
        -- project filter: the member-level lookup is the only read shape.
        CREATE INDEX agent_memory_member ON agent_memory (member_id, created_at);
      `);
    },
  },
  {
    // The human-epoch and response-budget ticket merged after the memory step;
    // it lands as the next strict +1 of the chain.
    to: 10,
    apply(db) {
      db.exec(`
        -- The budget ledger (预算表) is the canonical jump count: one row per
        -- target, so a target that burns its budget never locks another one.
        -- epoch_seq is the human epoch (the seq of the message that opened it;
        -- 0 while no epoch has opened yet) and used counts the agent-to-agent
        -- jumps delivered inside that epoch.
        --
        -- limit_value snapshots the ceiling that was in force when the epoch
        -- opened, so a channel upper-bound change only takes effect at the next
        -- human epoch. The human face has no write path to this table (ADR
        -- 0004); used only moves from the backend's epoch reset and jump
        -- delivery, and the row CHECK keeps a jump from ever overshooting its
        -- epoch's ceiling.
        CREATE TABLE target_budget (
          target_id TEXT PRIMARY KEY REFERENCES target (id),
          epoch_seq INTEGER NOT NULL CHECK (epoch_seq >= 0),
          used INTEGER NOT NULL CHECK (used >= 0),
          limit_value INTEGER NOT NULL CHECK (limit_value IN (3, 5, 10)),
          CHECK (used <= limit_value)
        );
      `);
    },
  },
  {
    // The provider ticket merged after the budget step; it lands as the next
    // strict +1 of the chain.
    to: 11,
    apply(db) {
      db.exec(`
        -- The remote data flow consent (远端数据流告知): one row per confirmed
        -- scope, recording only when the owner confirmed it. It deliberately
        -- has no connection parameters and no credential of any kind — the
        -- provider is named by its scope_id, and the credential itself is read
        -- from an environment variable at call time, never stored.
        --
        -- The key is the pair: a provider is confirmed once, and a second
        -- consent for the same scope is not a new fact.
        CREATE TABLE remote_consent_scope (
          scope_kind TEXT NOT NULL CHECK (scope_kind = 'model'),
          scope_id TEXT NOT NULL CHECK (scope_id IN ('anthropic', 'openai')),
          confirmed_at TEXT NOT NULL,
          PRIMARY KEY (scope_kind, scope_id)
        );
      `);
    },
  },
  {
    // The read-position ticket lands here as the next strict +1 of the chain.
    to: 12,
    apply(db) {
      db.exec(`
        -- 已读位置 (Read Position): one row per member per target, the canonical
        -- "how far has this member read" number. The owner's row is the unread
        -- badge's baseline and an Agent's row is its consumption cursor — the
        -- same table, two different facts, so neither reads the other's row.
        --
        -- The position only ever moves monotonically inside one target and is
        -- clamped to the target's current maximum seq by the write path, so a
        -- "future message is already read" state cannot be constructed here.
        CREATE TABLE read_position (
          member_id TEXT NOT NULL REFERENCES member (id),
          target_id TEXT NOT NULL REFERENCES target (id),
          last_read_seq INTEGER NOT NULL CHECK (last_read_seq >= 0),
          PRIMARY KEY (member_id, target_id)
        );

        -- Unread reads one member's positions across targets; a target's
        -- positions are read when a round closes, so the target gets its own
        -- lookup.
        CREATE INDEX read_position_target ON read_position (target_id);
      `);
    },
  },
  {
    // The reminder ticket lands here as the next strict +1 of the chain.
    to: 13,
    apply(db) {
      db.exec(`
        -- 提醒 (Reminder): the owner's one-shot local date + clock with a text
        -- note, optionally owned by a channel. due_at_local is the fixed-format
        -- local wall time the owner typed; created_at stays the UTC audit stamp
        -- and the two are never converted against each other.
        --
        -- delivered_at is the due marker (NULL = not due yet). It carries both
        -- "deliver at most once" and "catch up at most once": a reminder found
        -- more than 24 hours late is only marked, never delivered. missed keeps
        -- that lateness fact on the row, so a read does not have to reinterpret
        -- a local time against a UTC stamp.
        CREATE TABLE reminder (
          id TEXT PRIMARY KEY,
          channel_id TEXT REFERENCES channel (id),
          due_at_local TEXT NOT NULL CHECK (
            due_at_local GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]'
          ),
          text TEXT NOT NULL CHECK (length(text) > 0),
          delivered_at TEXT,
          missed INTEGER NOT NULL DEFAULT 0 CHECK (missed IN (0, 1)),
          created_at TEXT NOT NULL,
          CHECK (missed = 0 OR delivered_at IS NOT NULL)
        );
      `);
    },
  },
];

export type MigrationOutcome =
  | { status: 'migrated'; from: number | null; to: number; backupPath: string | null }
  | { status: 'already-current'; version: number };

export function databaseExists(dataDir: string): boolean {
  return existsSync(databasePath(dataDir));
}

export function migrateDataDir(dataDir: string): MigrationOutcome {
  return runMigrations(dataDir, MIGRATION_STEPS);
}

/**
 * Execute a migration step chain against a data directory. A non-empty data
 * directory is backed up to a sibling directory first; backup failure aborts
 * the migration. All schema steps and the version bump share one transaction,
 * and the audit ledger gains exactly one record per attempted migration.
 *
 * Exported for the test-only migration fixture: production callers go through
 * the CLI, which passes the production chain.
 */
export function runMigrations(
  dataDir: string,
  steps: readonly MigrationStep[] = MIGRATION_STEPS,
): MigrationOutcome {
  mkdirSync(dataDir, { recursive: true });

  const dbPath = databasePath(dataDir);
  const currentVersion = readSchemaVersion(dbPath);
  const targetVersion = steps[steps.length - 1]?.to ?? 0;

  if (currentVersion !== null && currentVersion === targetVersion) {
    return { status: 'already-current', version: currentVersion };
  }
  if (currentVersion !== null && currentVersion > targetVersion) {
    throw new Error(
      `version_mismatch: database schema version ${currentVersion} is newer than this build's ` +
        `schema version ${targetVersion}; refusing to migrate, there is no downgrade path`,
    );
  }

  const startedAt = new Date().toISOString();
  const pendingSteps = steps.filter((step) => step.to > (currentVersion ?? 0));
  let backupPath: string | null = null;

  try {
    if (!isDataDirEmpty(dataDir)) {
      backupPath = createDataDirBackup(dataDir, startedAt);
    }

    const db = new Database(dbPath);
    try {
      db.transaction(() => {
        for (const step of pendingSteps) {
          step.apply(db);
        }
        db.prepare('UPDATE schema_meta SET schema_version = ?').run(targetVersion);
      })();
    } finally {
      db.close();
    }
  } catch (error) {
    appendMigrationRecord(dataDir, {
      from: currentVersion,
      to: targetVersion,
      result: 'failed',
      reason: errorMessage(error),
      backup_path: backupPath,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
    });
    throw error;
  }

  appendMigrationRecord(dataDir, {
    from: currentVersion,
    to: targetVersion,
    result: 'ok',
    backup_path: backupPath,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
  });

  return { status: 'migrated', from: currentVersion, to: targetVersion, backupPath };
}

/**
 * Open the migrated database of a data directory for the serving process.
 * better-sqlite3 enables foreign keys by default; the server keeps that on so
 * `agent_config.member_id` cannot point at a missing member.
 */
export function openDatabase(dataDir: string): Database.Database {
  const db = new Database(databasePath(dataDir));
  db.pragma('foreign_keys = ON');
  return db;
}

/**
 * The version gate for the serve path: a database older than the code has to
 * be migrated explicitly, and a database newer than the code has no downgrade
 * path. The check is read-only, so a refused database is left byte-identical.
 */
export function assertServeableSchemaVersion(dataDir: string): void {
  const version = readSchemaVersion(databasePath(dataDir));
  if (version === null || version < SCHEMA_VERSION) {
    const found = version === null ? 'has no schema version' : `is at schema version ${version}`;
    throw new Error(
      `version_mismatch: database ${found} but this build expects schema version ${SCHEMA_VERSION}; ` +
        `run \`allibot --migrate --data-dir ${dataDir}\` before starting the server`,
    );
  }
  if (version > SCHEMA_VERSION) {
    throw new Error(
      `version_mismatch: database schema version ${version} is newer than this build's ` +
        `schema version ${SCHEMA_VERSION}; refusing to start, there is no downgrade path`,
    );
  }
}

function readSchemaVersion(dbPath: string): number | null {
  if (!existsSync(dbPath)) {
    return null;
  }

  const db = new Database(dbPath, { readonly: true });
  try {
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'")
      .get();
    if (table === undefined) {
      return null;
    }
    const row = db
      .prepare('SELECT schema_version FROM schema_meta')
      .get() as { schema_version: number } | undefined;
    if (row === undefined) {
      throw new Error('schema_meta is empty; refusing to migrate');
    }
    return row.schema_version;
  } finally {
    db.close();
  }
}

/**
 * The single-writer lock is runtime state, not data: a directory holding only
 * the lock file counts as empty, so initializing it needs no backup.
 */
function isDataDirEmpty(dataDir: string): boolean {
  return readdirSync(dataDir).every((entry) => entry === LOCK_FILENAME);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
