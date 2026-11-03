import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { makeTempDir, readLedger, removeTempDir, runCli } from './support.ts';

interface MemberRow {
  id: string;
  kind: string;
  display_name: string;
  avatar_slot: number;
  deleted_at: string | null;
  created_at: string;
}

function createVersionOneDatabase(dataDir: string): void {
  const db = new Database(path.join(dataDir, 'allibot.db'));
  try {
    db.exec('CREATE TABLE schema_meta (schema_version INTEGER NOT NULL)');
    db.prepare('INSERT INTO schema_meta (schema_version) VALUES (1)').run();
  } finally {
    db.close();
  }
}

function readSchemaVersion(dataDir: string): unknown {
  const db = new Database(path.join(dataDir, 'allibot.db'), { readonly: true });
  try {
    return (
      db.prepare('SELECT schema_version FROM schema_meta').get() as {
        schema_version: unknown;
      }
    ).schema_version;
  } finally {
    db.close();
  }
}

function tableNames(dataDir: string): string[] {
  const db = new Database(path.join(dataDir, 'allibot.db'), { readonly: true });
  try {
    return (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as { name: string }[]
    ).map((row) => row.name);
  } finally {
    db.close();
  }
}

function columnNames(dataDir: string, table: string): string[] {
  const db = new Database(path.join(dataDir, 'allibot.db'), { readonly: true });
  try {
    return (db.pragma(`table_info(${table})`) as { name: string }[]).map((row) => row.name);
  } finally {
    db.close();
  }
}

function readMembers(dataDir: string): MemberRow[] {
  const db = new Database(path.join(dataDir, 'allibot.db'), { readonly: true });
  try {
    return db
      .prepare(
        'SELECT id, kind, display_name, avatar_slot, deleted_at, created_at FROM member ORDER BY kind, id',
      )
      .all() as MemberRow[];
  } finally {
    db.close();
  }
}

function countRows(dataDir: string, table: 'member' | 'agent_config'): number {
  const db = new Database(path.join(dataDir, 'allibot.db'), { readonly: true });
  try {
    const row = db.prepare(`SELECT count(*) AS total FROM ${table}`).get() as { total: number };
    return row.total;
  } finally {
    db.close();
  }
}

test('migrating an empty data dir creates member and agent_config with exactly one owner', async () => {
  const dataDir = await makeTempDir('allibot-members-migrate-');
  try {
    const result = runCli(['--migrate', '--data-dir', dataDir]);
    assert.equal(result.exitCode, 0, `migrate should exit 0; output: ${result.output}`);

    assert.equal(readSchemaVersion(dataDir), 10);
    const tables = tableNames(dataDir);
    assert.ok(tables.includes('member'), `member table is missing; tables: ${tables.join(', ')}`);
    assert.ok(
      tables.includes('agent_config'),
      `agent_config table is missing; tables: ${tables.join(', ')}`,
    );

    assert.deepEqual(
      columnNames(dataDir, 'member'),
      ['id', 'kind', 'display_name', 'avatar_slot', 'deleted_at', 'created_at'],
    );
    assert.deepEqual(
      columnNames(dataDir, 'agent_config'),
      [
        'member_id',
        'role',
        'model',
        'system_prompt',
        'enabled',
        'context_window',
        'compression_threshold',
        'max_iterations',
        'auto_claim',
      ],
    );

    const members = readMembers(dataDir);
    assert.equal(members.length, 1, 'a fresh migration seeds exactly one member row');
    const owner = members[0];
    assert.ok(owner !== undefined);
    assert.equal(owner.kind, 'owner');
    assert.equal(owner.deleted_at, null);
    assert.ok(owner.display_name.length > 0, 'the owner needs a display name');
    assert.ok(
      Number.isInteger(owner.avatar_slot) && owner.avatar_slot >= 0 && owner.avatar_slot <= 4,
      `avatar_slot must be 0..4, got ${String(owner.avatar_slot)}`,
    );
    assert.ok(Number.isFinite(Date.parse(owner.created_at)), 'created_at must be an ISO timestamp');

    assert.equal(countRows(dataDir, 'agent_config'), 0, 'the owner has no agent config');

    const entries = readLedger(dataDir);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.['from'], null);
    assert.equal(entries[0]?.['to'], 10);
    assert.equal(entries[0]?.['result'], 'ok');
  } finally {
    await removeTempDir(dataDir);
  }
});

test('a version 1 data dir is backed up and upgraded through the production chain', async () => {
  const parent = await makeTempDir('allibot-members-upgrade-');
  const dataDir = path.join(parent, 'data');
  let backupPath: string | undefined;

  try {
    mkdirSync(dataDir);
    createVersionOneDatabase(dataDir);
    writeFileSync(path.join(dataDir, 'sentinel.txt'), 'keep me\n', 'utf8');

    const result = runCli(['--migrate', '--data-dir', dataDir]);
    assert.equal(result.exitCode, 0, `migrate should exit 0; output: ${result.output}`);

    assert.equal(readSchemaVersion(dataDir), 10);
    assert.ok(tableNames(dataDir).includes('member'));
    assert.ok(tableNames(dataDir).includes('agent_config'));

    const members = readMembers(dataDir);
    assert.equal(members.length, 1);
    assert.equal(members[0]?.kind, 'owner');

    const backups = readdirSync(parent).filter((name) => name.startsWith('data.backup-'));
    assert.equal(backups.length, 1, `expected exactly one backup, saw: ${backups.join(', ')}`);
    backupPath = path.join(parent, backups[0] ?? '');
    assert.equal(existsSync(path.join(backupPath, 'sentinel.txt')), true);

    const backupDb = new Database(path.join(backupPath, 'allibot.db'), { readonly: true });
    try {
      const row = backupDb.prepare('SELECT schema_version FROM schema_meta').get() as {
        schema_version: number;
      };
      assert.equal(row.schema_version, 1, 'the backup keeps the pre-migration schema version');
      const tables = (
        backupDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
          name: string;
        }[]
      ).map((table) => table.name);
      assert.equal(tables.includes('member'), false, 'the backup predates the member table');
    } finally {
      backupDb.close();
    }

    const entries = readLedger(dataDir);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.['from'], 1);
    assert.equal(entries[0]?.['to'], 10);
    assert.equal(entries[0]?.['result'], 'ok');
    assert.equal(entries[0]?.['backup_path'], backupPath);
  } finally {
    await removeTempDir(parent);
  }
});

test('the member table refuses a second owner row', async () => {
  const dataDir = await makeTempDir('allibot-members-owner-unique-');
  try {
    const result = runCli(['--migrate', '--data-dir', dataDir]);
    assert.equal(result.exitCode, 0, `migrate should exit 0; output: ${result.output}`);

    const db = new Database(path.join(dataDir, 'allibot.db'));
    try {
      assert.throws(
        () =>
          db
            .prepare(
              'INSERT INTO member (id, kind, display_name, avatar_slot, created_at) VALUES (?, ?, ?, ?, ?)',
            )
            .run(randomUUID(), 'owner', 'Intruder', 1, new Date().toISOString()),
        /UNIQUE|constraint/i,
        'the database must enforce a single owner row',
      );
    } finally {
      db.close();
    }

    assert.equal(readMembers(dataDir).filter((member) => member.kind === 'owner').length, 1);
  } finally {
    await removeTempDir(dataDir);
  }
});
