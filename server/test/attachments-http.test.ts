import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import {
  makeTempDir,
  removeTempDir,
  runCli,
  startServer,
  type RunningServer,
} from './support.ts';

interface AttachmentFixture {
  dataDir: string;
  running: RunningServer;
  base: string;
  stop: () => Promise<void>;
  stopServer: () => Promise<void>;
}

interface UploadPart {
  name: string;
  filename?: string;
  contentType?: string;
  data: Buffer | string;
}

/**
 * A hand-built multipart/form-data body, byte for byte what `curl -F` puts on
 * the wire. Building it here keeps the fixture independent of the client's
 * FormData implementation and lets a test choose the filename, the part's
 * Content-Type and the exact bytes.
 */
function multipartBody(parts: readonly UploadPart[], boundary: string): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"`;
    if (part.filename !== undefined) {
      head += `; filename="${part.filename}"`;
    }
    head += '\r\n';
    if (part.contentType !== undefined) {
      head += `Content-Type: ${part.contentType}\r\n`;
    }
    head += '\r\n';
    chunks.push(Buffer.from(head, 'utf8'));
    chunks.push(Buffer.isBuffer(part.data) ? part.data : Buffer.from(part.data, 'utf8'));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

const BOUNDARY = '----allibotAttachmentBoundary';

/** Bytes chosen to include NUL, CRLF and a token that looks like a boundary. */
function fixtureBytes(seed: string): Buffer {
  return Buffer.concat([
    Buffer.from(`附件 fixture: ${seed}\n`, 'utf8'),
    Buffer.from(Array.from({ length: 256 }, (_, index) => index)),
    Buffer.from('\r\n------not-a-boundary\r\n', 'utf8'),
  ]);
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function startAttachmentFixture(prefix: string): Promise<AttachmentFixture> {
  const dataDir = await makeTempDir(prefix);
  const migration = runCli(['--migrate', '--data-dir', dataDir]);
  assert.equal(migration.exitCode, 0, `migrate should exit 0; output: ${migration.output}`);
  const running = await startServer(dataDir);
  return {
    dataDir,
    running,
    base: `http://127.0.0.1:${running.port}`,
    stopServer: async () => {
      await running.stop();
    },
    stop: async () => {
      await running.stop();
      await removeTempDir(dataDir);
    },
  };
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json();
  assert.ok(typeof body === 'object' && body !== null, 'response body should be a JSON object');
  return body as Record<string, unknown>;
}

function errorCode(body: Record<string, unknown>): unknown {
  return (body['error'] as Record<string, unknown> | undefined)?.['code'];
}

async function upload(
  fixture: AttachmentFixture,
  parts: readonly UploadPart[],
): Promise<Response> {
  return await fetch(`${fixture.base}/api/attachments`, {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
    body: multipartBody(parts, BOUNDARY),
  });
}

async function uploadFile(
  fixture: AttachmentFixture,
  filename: string,
  bytes: Buffer,
  contentType = 'application/octet-stream',
): Promise<string> {
  const response = await upload(fixture, [{ name: 'file', filename, contentType, data: bytes }]);
  assert.equal(response.status, 201, await response.clone().text());
  return (await readJson(response))['id'] as string;
}

async function postJson(
  fixture: AttachmentFixture,
  route: string,
  body: unknown,
): Promise<Response> {
  return await fetch(`${fixture.base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function createChannel(fixture: AttachmentFixture): Promise<string> {
  const created = await postJson(fixture, '/api/channels', {
    name: '附件频道',
    description: '附件写读路径',
    mode: 'autonomous',
  });
  assert.equal(created.status, 201, await created.clone().text());
  return (await readJson(created))['id'] as string;
}

interface AttachmentRow {
  id: string;
  message_id: string | null;
  filename: string;
  mime: string;
  size: number;
  storage_path: string;
  created_at: string;
}

function attachmentRow(dataDir: string, id: string): AttachmentRow | undefined {
  const db = new Database(path.join(dataDir, 'allibot.db'), { readonly: true });
  try {
    return db
      .prepare(
        `SELECT id, message_id, filename, mime, size, storage_path, created_at
           FROM attachment WHERE id = ?`,
      )
      .get(id) as AttachmentRow | undefined;
  } finally {
    db.close();
  }
}

function countAttachments(dataDir: string): number {
  const db = new Database(path.join(dataDir, 'allibot.db'), { readonly: true });
  try {
    return (db.prepare('SELECT count(*) AS total FROM attachment').get() as { total: number })
      .total;
  } finally {
    db.close();
  }
}

async function listMessages(
  fixture: AttachmentFixture,
  targetId: string,
): Promise<Record<string, unknown>[]> {
  const response = await fetch(`${fixture.base}/api/targets/${targetId}/messages`);
  assert.equal(response.status, 200, await response.clone().text());
  return (await readJson(response))['messages'] as Record<string, unknown>[];
}

test('an upload is a draft: the bytes land in the data dir and no read path exposes it yet', async () => {
  const fixture = await startAttachmentFixture('allibot-attachments-draft-');
  try {
    const bytes = fixtureBytes('draft');
    const response = await upload(fixture, [
      { name: 'file', filename: '草稿.txt', contentType: 'text/plain; charset=utf-8', data: bytes },
    ]);
    assert.equal(response.status, 201, await response.clone().text());
    const created = await readJson(response);
    assert.deepEqual(Object.keys(created), ['id'], 'the upload answers the new identity only');
    const id = created['id'] as string;

    const row = attachmentRow(fixture.dataDir, id);
    assert.ok(row !== undefined, 'the metadata row is written');
    assert.equal(row.message_id, null, 'an unbound upload is a draft');
    assert.equal(row.filename, '草稿.txt');
    assert.equal(row.mime, 'text/plain', 'the media type essence is stored, parameters dropped');
    assert.equal(row.size, bytes.length);
    assert.ok(Number.isFinite(Date.parse(row.created_at)), 'created_at is an ISO timestamp');

    assert.notEqual(row.storage_path, row.filename, 'the storage path never reuses the user filename');
    assert.ok(!row.storage_path.includes('/'), `storage_path must be a bare name: ${row.storage_path}`);
    const storedPath = path.join(fixture.dataDir, 'attachments', row.storage_path);
    assert.equal(existsSync(storedPath), true, `bytes should exist at ${storedPath}`);
    assert.equal(sha256(readFileSync(storedPath)), sha256(bytes), 'the stored bytes are the uploaded bytes');

    const draft = await fetch(`${fixture.base}/api/attachments/${id}`);
    assert.equal(draft.status, 404, 'a draft is not on any read surface');
    assert.equal(errorCode(await readJson(draft)), 'not_found');

    const unknown = await fetch(`${fixture.base}/api/attachments/does-not-exist`);
    assert.equal(unknown.status, 404);
    assert.equal(errorCode(await readJson(unknown)), 'not_found');

    const notMultipart = await postJson(fixture, '/api/attachments', { file: 'x' });
    assert.equal(notMultipart.status, 400);
    assert.equal(errorCode(await readJson(notMultipart)), 'validation_failed');

    const wrongField = await upload(fixture, [
      { name: 'upload', filename: 'a.txt', contentType: 'text/plain', data: 'x' },
    ]);
    assert.equal(wrongField.status, 400, 'the only accepted field is file');
    assert.equal(errorCode(await readJson(wrongField)), 'validation_failed');

    const noFilename = await upload(fixture, [{ name: 'file', data: 'x' }]);
    assert.equal(noFilename.status, 400, 'a part without a filename is not a file object');
    assert.equal(errorCode(await readJson(noFilename)), 'validation_failed');
  } finally {
    await fixture.stop();
  }
});

test('binding a draft to a message exposes its metadata and serves the same bytes', async () => {
  const fixture = await startAttachmentFixture('allibot-attachments-bind-');
  try {
    const channelId = await createChannel(fixture);
    const firstBytes = fixtureBytes('first');
    const secondBytes = fixtureBytes('second');
    const firstId = await uploadFile(fixture, '报告.txt', firstBytes, 'text/plain');
    const secondId = await uploadFile(fixture, '图表.bin', secondBytes, 'application/octet-stream');

    const created = await postJson(fixture, `/api/targets/${channelId}/messages`, {
      body: '带两个附件',
      attachment_ids: [firstId, secondId],
    });
    assert.equal(created.status, 201, await created.clone().text());
    const messageId = (await readJson(created))['id'] as string;

    assert.equal(attachmentRow(fixture.dataDir, firstId)?.message_id, messageId);
    assert.equal(attachmentRow(fixture.dataDir, secondId)?.message_id, messageId);

    const messages = await listMessages(fixture, channelId);
    assert.equal(messages.length, 1);
    const attachments = messages[0]?.['attachments'] as Record<string, unknown>[];
    assert.deepEqual(attachments, [
      { id: firstId, filename: '报告.txt', mime: 'text/plain', size: firstBytes.length },
      { id: secondId, filename: '图表.bin', mime: 'application/octet-stream', size: secondBytes.length },
    ]);
    const serialized = JSON.stringify(messages);
    assert.ok(!serialized.includes('storage_path'), 'the message read never exposes storage_path');
    assert.ok(!serialized.includes('attachments/'), 'no storage directory leaks into the read');

    const download = await fetch(`${fixture.base}/api/attachments/${firstId}`);
    assert.equal(download.status, 200, await download.clone().text());
    assert.match(download.headers.get('content-type') ?? '', /^text\/plain/);
    assert.equal(download.headers.get('content-length'), String(firstBytes.length));
    const disposition = download.headers.get('content-disposition') ?? '';
    assert.match(disposition, /^attachment;/);
    assert.match(disposition, /filename\*=UTF-8''%E6%8A%A5%E5%91%8A\.txt/);
    assert.equal(sha256(Buffer.from(await download.arrayBuffer())), sha256(firstBytes));

    const binary = await fetch(`${fixture.base}/api/attachments/${secondId}`);
    assert.equal(binary.status, 200);
    assert.match(binary.headers.get('content-type') ?? '', /^application\/octet-stream/);
    assert.equal(sha256(Buffer.from(await binary.arrayBuffer())), sha256(secondBytes));

    // The bytes are still where the data directory backup unit expects them.
    const storagePath = attachmentRow(fixture.dataDir, firstId)?.storage_path ?? '';
    assert.equal(
      sha256(readFileSync(path.join(fixture.dataDir, 'attachments', storagePath))),
      sha256(firstBytes),
    );
  } finally {
    await fixture.stop();
  }
});

test('a second binding is a conflict, unknown ids fail validation, and a failed bind writes nothing', async () => {
  const fixture = await startAttachmentFixture('allibot-attachments-conflict-');
  try {
    const channelA = await createChannel(fixture);
    const channelB = await createChannel(fixture);
    const bytes = fixtureBytes('conflict');
    const attachmentId = await uploadFile(fixture, '一次.txt', bytes, 'text/plain');

    const first = await postJson(fixture, `/api/targets/${channelA}/messages`, {
      body: '第一次绑定',
      attachment_ids: [attachmentId],
    });
    assert.equal(first.status, 201, await first.clone().text());

    const second = await postJson(fixture, `/api/targets/${channelB}/messages`, {
      body: '第二次绑定',
      attachment_ids: [attachmentId],
    });
    assert.equal(second.status, 409, await second.clone().text());
    assert.equal(errorCode(await readJson(second)), 'conflict');
    assert.equal(countAttachments(fixture.dataDir), 1, 'the conflict adds no attachment row');
    assert.deepEqual((await listMessages(fixture, channelB)), [], 'the refused message is not written');

    const unknown = await postJson(fixture, `/api/targets/${channelB}/messages`, {
      body: '不存在的附件',
      attachment_ids: ['does-not-exist'],
    });
    assert.equal(unknown.status, 400);
    assert.equal(errorCode(await readJson(unknown)), 'validation_failed');

    // Binding is in the message transaction: one bad id rolls the whole write back.
    const freshId = await uploadFile(fixture, '原子.txt', bytes, 'text/plain');
    const mixed = await postJson(fixture, `/api/targets/${channelB}/messages`, {
      body: '一半有效',
      attachment_ids: [freshId, attachmentId],
    });
    assert.equal(mixed.status, 409, await mixed.clone().text());
    assert.deepEqual(await listMessages(fixture, channelB), [], 'no message row survives the rollback');
    assert.equal(attachmentRow(fixture.dataDir, freshId)?.message_id, null, 'the valid draft stays a draft');

    const duplicated = await postJson(fixture, `/api/targets/${channelB}/messages`, {
      body: '重复 id',
      attachment_ids: [freshId, freshId],
    });
    assert.equal(duplicated.status, 400);
    assert.equal(errorCode(await readJson(duplicated)), 'validation_failed');

    const wrongShape = await postJson(fixture, `/api/targets/${channelB}/messages`, {
      body: '不是数组',
      attachment_ids: freshId,
    });
    assert.equal(wrongShape.status, 400);
    assert.equal(errorCode(await readJson(wrongShape)), 'validation_failed');

    const stillABinding = await postJson(fixture, `/api/targets/${channelB}/messages`, {
      body: '正常绑定',
      attachment_ids: [freshId],
    });
    assert.equal(stillABinding.status, 201, 'the draft is still bindable after the refusals');
  } finally {
    await fixture.stop();
  }
});

test('the attachment table rejects UPDATE and DELETE and the row stays', async () => {
  const fixture = await startAttachmentFixture('allibot-attachments-immutable-');
  try {
    const channelId = await createChannel(fixture);
    const bytes = fixtureBytes('immutable');
    const attachmentId = await uploadFile(fixture, '不可改.txt', bytes, 'text/plain');
    const otherId = await uploadFile(fixture, '另一个.txt', bytes, 'text/plain');
    const firstMessage = await postJson(fixture, `/api/targets/${channelId}/messages`, {
      body: '绑定',
      attachment_ids: [attachmentId],
    });
    assert.equal(firstMessage.status, 201, await firstMessage.clone().text());
    const otherMessage = await postJson(fixture, `/api/targets/${channelId}/messages`, {
      body: '第二条',
    });
    assert.equal(otherMessage.status, 201, await otherMessage.clone().text());
    const otherMessageId = (await readJson(otherMessage))['id'] as string;
    await fixture.stopServer();

    const dbPath = path.join(fixture.dataDir, 'allibot.db');
    const sql = (statement: string): { status: number | null; output: string } => {
      const result = spawnSync('sqlite3', [dbPath, statement], { encoding: 'utf8' });
      return { status: result.status, output: `${result.stdout}${result.stderr}` };
    };

    const rename = sql("update attachment set filename='改名.txt'");
    assert.notEqual(rename.status, 0, 'renaming an attachment is refused');
    assert.match(rename.output, /immutable/i);

    const repoint = sql(`update attachment set storage_path='elsewhere'`);
    assert.notEqual(repoint.status, 0, 'moving the bytes of an attachment is refused');

    const unbind = sql('update attachment set message_id = NULL');
    assert.notEqual(unbind.status, 0, 'unbinding an attachment is refused');

    const rebind = sql(`update attachment set message_id='${otherMessageId}'`);
    assert.notEqual(rebind.status, 0, 'binding twice is refused');

    const remove = sql('delete from attachment');
    assert.notEqual(remove.status, 0, 'deleting an attachment is refused');
    assert.match(remove.output, /immutable/i);

    assert.equal(countAttachments(fixture.dataDir), 2, 'both attachment rows are still there');
    assert.equal(attachmentRow(fixture.dataDir, attachmentId)?.filename, '不可改.txt');
    assert.equal(attachmentRow(fixture.dataDir, otherId)?.message_id, null);
  } finally {
    await fixture.stop();
  }
});

test('archived channels refuse attachment binding with 400 and deleted channels with 404', async () => {
  const fixture = await startAttachmentFixture('allibot-attachments-guards-');
  try {
    const archivedChannel = await createChannel(fixture);
    const archivedDraft = await uploadFile(fixture, '归档.txt', fixtureBytes('archived'), 'text/plain');
    assert.equal(
      (await postJson(fixture, `/api/channels/${archivedChannel}/archive`, {})).status,
      200,
    );
    const archived = await postJson(fixture, `/api/targets/${archivedChannel}/messages`, {
      body: '归档频道',
      attachment_ids: [archivedDraft],
    });
    assert.equal(archived.status, 400);
    assert.equal(errorCode(await readJson(archived)), 'validation_failed');
    assert.equal(attachmentRow(fixture.dataDir, archivedDraft)?.message_id, null);

    const deletedChannel = await createChannel(fixture);
    const deletedDraft = await uploadFile(fixture, '删除.txt', fixtureBytes('deleted'), 'text/plain');
    assert.equal(
      (await fetch(`${fixture.base}/api/channels/${deletedChannel}`, { method: 'DELETE' })).status,
      204,
    );
    const deleted = await postJson(fixture, `/api/targets/${deletedChannel}/messages`, {
      body: '已删除频道',
      attachment_ids: [deletedDraft],
    });
    assert.equal(deleted.status, 404);
    assert.equal(errorCode(await readJson(deleted)), 'not_found');
    assert.equal(attachmentRow(fixture.dataDir, deletedDraft)?.message_id, null);

    const unknownTarget = await postJson(fixture, '/api/targets/does-not-exist/messages', {
      body: '不存在的 target',
      attachment_ids: [deletedDraft],
    });
    assert.equal(unknownTarget.status, 404);
    assert.equal(errorCode(await readJson(unknownTarget)), 'not_found');
  } finally {
    await fixture.stop();
  }
});

test('an upload above the size limit is refused with validation_failed, never truncated', async () => {
  const fixture = await startAttachmentFixture('allibot-attachments-limit-');
  try {
    const limit = 25 * 1024 * 1024;
    const tooLarge = Buffer.alloc(limit + 1, 0x61);
    const refused = await upload(fixture, [
      { name: 'file', filename: 'too-large.bin', contentType: 'application/octet-stream', data: tooLarge },
    ]);
    assert.equal(refused.status, 400, 'an oversized upload is a client error');
    assert.equal(errorCode(await readJson(refused)), 'validation_failed');
    assert.equal(countAttachments(fixture.dataDir), 0, 'a refused upload writes no row');

    const atLimit = await upload(fixture, [
      { name: 'file', filename: 'at-limit.bin', contentType: 'application/octet-stream', data: Buffer.alloc(limit, 0x62) },
    ]);
    assert.equal(atLimit.status, 201, 'exactly at the limit is still accepted');
    const id = (await readJson(atLimit))['id'] as string;
    assert.equal(attachmentRow(fixture.dataDir, id)?.size, limit);
  } finally {
    await fixture.stop();
  }
});

test('attachment metadata stays out of the member surface', async () => {
  const fixture = await startAttachmentFixture('allibot-attachments-members-');
  try {
    const channelId = await createChannel(fixture);
    const created = await postJson(fixture, '/api/agents', {
      display_name: '附件观察员',
      model: 'openai:gpt-5',
    });
    assert.equal(created.status, 201, await created.clone().text());
    const agentId = (await readJson(created))['id'] as string;
    assert.equal(
      (await postJson(fixture, `/api/channels/${channelId}/members`, { member_id: agentId })).status,
      200,
    );

    const id = await uploadFile(fixture, '成员面不可见.txt', fixtureBytes('members'), 'text/plain');
    assert.equal(
      (await postJson(fixture, `/api/targets/${channelId}/messages`, {
        body: '带附件',
        attachment_ids: [id],
      })).status,
      201,
    );

    const members = await fetch(`${fixture.base}/api/targets/${channelId}/members`);
    assert.equal(members.status, 200);
    const body = await readJson(members);
    const serialized = JSON.stringify(body);
    assert.ok(!serialized.includes('成员面不可见'), 'the member surface carries no attachment metadata');
    assert.ok(!serialized.includes('attachment'), 'the member surface has no attachment field');
    assert.deepEqual(
      Object.keys(body),
      ['members'],
      'the member surface keeps its single members key',
    );
  } finally {
    await fixture.stop();
  }
});

const curlAvailable = spawnSync('curl', ['--version'], { encoding: 'utf8' }).status === 0;

test(
  'a curl upload behaves like the hand-built multipart body',
  { skip: curlAvailable ? false : 'curl is not installed' },
  async () => {
    const fixture = await startAttachmentFixture('allibot-attachments-curl-');
    const parent = await makeTempDir('allibot-attachments-curl-file-');
    try {
      const bytes = fixtureBytes('curl');
      const fixturePath = path.join(parent, 'fixture.txt');
      writeFileSync(fixturePath, bytes);

      const result = spawnSync(
        'curl',
        [
          '-s',
          '-w',
          '\n%{http_code}',
          '-F',
          `file=@${fixturePath};type=text/plain;filename=fixture.txt`,
          `${fixture.base}/api/attachments`,
        ],
        { encoding: 'utf8' },
      );
      assert.equal(result.status, 0, `curl should exit 0; stderr: ${result.stderr}`);
      const [payload, status] = result.stdout.trimEnd().split('\n');
      assert.equal(status, '201', `curl should get 201; body: ${result.stdout}`);
      const id = (JSON.parse(payload ?? '{}') as { id?: string }).id;
      assert.ok(typeof id === 'string' && id.length > 0, 'the upload answers an id');

      const row = attachmentRow(fixture.dataDir, id);
      assert.ok(row !== undefined);
      assert.equal(row.filename, 'fixture.txt');
      assert.equal(row.mime, 'text/plain');
      assert.equal(row.size, bytes.length);
      assert.equal(
        sha256(readFileSync(path.join(fixture.dataDir, 'attachments', row.storage_path))),
        sha256(bytes),
      );
    } finally {
      await removeTempDir(parent);
      await fixture.stop();
    }
  },
);
