import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AttachmentView } from '@allibot/shared';
import type Database from 'better-sqlite3';
import { ApiFailure } from './api-error.js';

/**
 * The upload size ceiling for one attachment's bytes. It is a fixed, documented
 * number rather than an implicit socket limit: a larger file is refused with
 * `validation_failed` before anything is stored, never silently truncated.
 */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/**
 * Multipart headers and the boundary cost a few hundred bytes, so the request
 * envelope is read up to the attachment ceiling plus this slack. A file at
 * exactly the ceiling therefore still passes; a larger one is refused.
 */
const ENVELOPE_SLACK_BYTES = 64 * 1024;

/** The only accepted multipart field name. */
const FILE_FIELD = 'file';

/** Longest stored display filename; a longer name is a client error. */
const MAX_FILENAME_LENGTH = 255;

const MIME_ESSENCE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+\/[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const FALLBACK_MIME = 'application/octet-stream';

interface AttachmentRow {
  id: string;
  message_id: string | null;
  filename: string;
  mime: string;
  size: number;
  storage_path: string;
  created_at: string;
}

const ATTACHMENT_SELECT = `
SELECT id, message_id, filename, mime, size, storage_path, created_at
FROM attachment`;

/**
 * `POST /api/attachments`: read the multipart `file` part, write its bytes under
 * `<data dir>/attachments/<storage_path>` and record the metadata as an unbound
 * draft. The user filename is metadata only; the storage path is an opaque
 * server-chosen name, so a filename can never steer where bytes land.
 */
export async function uploadAttachment(
  dataDir: string,
  db: Database.Database,
  contentType: string | undefined,
  body: Buffer,
): Promise<{ id: string }> {
  const file = await parseMultipartFile(contentType, body);
  const id = randomUUID();
  const storagePath = randomUUID();
  const storedPath = attachmentStoragePath(dataDir, storagePath);

  mkdirSync(path.join(dataDir, 'attachments'), { recursive: true });
  // `wx` refuses to overwrite: the opaque name is fresh, and a collision must
  // abort rather than replace someone else's bytes.
  writeFileSync(storedPath, file.bytes, { flag: 'wx' });

  try {
    db.prepare(
      `INSERT INTO attachment (id, message_id, filename, mime, size, storage_path, created_at)
       VALUES (?, NULL, ?, ?, ?, ?, ?)`,
    ).run(id, file.filename, file.mime, file.bytes.length, storagePath, new Date().toISOString());
  } catch (error) {
    rmSync(storedPath, { force: true });
    throw error;
  }

  return { id };
}

/**
 * `GET /api/attachments/{id}`: only a bound attachment is on a read surface. A
 * draft answers 404 exactly like an unknown id, so the upload step cannot be
 * used to probe bytes that no message carries.
 */
export function readAttachment(
  dataDir: string,
  db: Database.Database,
  id: string,
): { filename: string; mime: string; bytes: Buffer } {
  const row = db.prepare(`${ATTACHMENT_SELECT} WHERE id = ?`).get(id) as
    | AttachmentRow
    | undefined;
  if (row === undefined || row.message_id === null) {
    throw ApiFailure.notFound(`attachment not found: ${id}`);
  }
  // The stored path is written by this module, but resolve it back through the
  // attachments directory so a hand-edited row still cannot read outside it.
  const storedPath = attachmentStoragePath(dataDir, row.storage_path);
  let bytes: Buffer;
  try {
    bytes = readFileSync(storedPath);
  } catch {
    throw new Error(`attachment bytes are missing from the data directory: ${row.id}`);
  }
  return { filename: row.filename, mime: row.mime, bytes };
}

/**
 * Bind drafts to the message that is being written, inside the caller's
 * transaction. The UPDATE is guarded by `message_id IS NULL`, so a second
 * binding of the same attachment changes nothing; the follow-up read splits
 * "unknown attachment" (validation) from "already bound" (conflict).
 */
export function bindAttachments(
  db: Database.Database,
  messageId: string,
  attachmentIds: readonly string[],
): void {
  if (attachmentIds.length === 0) {
    return;
  }
  const bind = db.prepare('UPDATE attachment SET message_id = ? WHERE id = ? AND message_id IS NULL');
  const read = db.prepare('SELECT message_id FROM attachment WHERE id = ?');
  for (const id of attachmentIds) {
    if (bind.run(messageId, id).changes === 1) {
      continue;
    }
    const row = read.get(id) as { message_id: string | null } | undefined;
    if (row === undefined) {
      throw ApiFailure.validation(`unknown attachment: ${id}`, { field: 'attachment_ids', value: id });
    }
    throw ApiFailure.conflict(`attachment is already bound to a message: ${id}`, {
      field: 'attachment_ids',
      value: id,
    });
  }
}

/** Every message read hydrates its attachments in upload order. */
export function listAttachmentsForMessages(
  db: Database.Database,
  messageIds: readonly string[],
): Map<string, AttachmentView[]> {
  const byMessage = new Map<string, AttachmentView[]>();
  if (messageIds.length === 0) {
    return byMessage;
  }
  const placeholders = messageIds.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `${ATTACHMENT_SELECT} WHERE message_id IN (${placeholders}) ORDER BY rowid`,
    )
    .all(...messageIds) as AttachmentRow[];
  for (const row of rows) {
    if (row.message_id === null) {
      continue;
    }
    const bucket = byMessage.get(row.message_id) ?? [];
    bucket.push({ id: row.id, filename: row.filename, mime: row.mime, size: row.size });
    byMessage.set(row.message_id, bucket);
  }
  return byMessage;
}

/** The one place that turns an opaque storage name into a path inside the data dir. */
function attachmentStoragePath(dataDir: string, storagePath: string): string {
  const root = path.join(dataDir, 'attachments');
  const resolved = path.resolve(root, storagePath);
  if (!resolved.startsWith(`${path.resolve(root)}${path.sep}`)) {
    throw new Error(`attachment storage path escapes the attachments directory: ${storagePath}`);
  }
  return resolved;
}

interface ParsedFile {
  filename: string;
  mime: string;
  bytes: Buffer;
}

/**
 * Read the single multipart `file` part. Node's built-in FormData parser is the
 * whole multipart implementation: no dependency, no hand-rolled boundary
 * scanning. A malformed envelope is a client error, not a crash.
 */
async function parseMultipartFile(
  contentType: string | undefined,
  body: Buffer,
): Promise<ParsedFile> {
  if (contentType === undefined || !/^multipart\/form-data\b/i.test(contentType)) {
    throw ApiFailure.validation('request body must be multipart/form-data with a file field');
  }

  let form: FormData;
  try {
    form = await new Response(body, { headers: { 'content-type': contentType } }).formData();
  } catch {
    throw ApiFailure.validation('request body is not a valid multipart/form-data body');
  }
  return await parseFormData(form);
}

async function parseFormData(form: FormData): Promise<ParsedFile> {
  for (const key of form.keys()) {
    if (key !== FILE_FIELD) {
      throw ApiFailure.validation(`unknown field: ${key}`);
    }
  }
  const files = form.getAll(FILE_FIELD);
  if (files.length === 0) {
    throw ApiFailure.validation(`multipart field is required: ${FILE_FIELD}`);
  }
  if (files.length > 1) {
    throw ApiFailure.validation(`multipart field must appear once: ${FILE_FIELD}`);
  }
  const file = files[0];
  if (!(file instanceof File)) {
    throw ApiFailure.validation(`multipart field must be a file object: ${FILE_FIELD}`);
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw ApiFailure.validation(
      `attachment exceeds the ${MAX_ATTACHMENT_BYTES} byte limit`,
      { field: FILE_FIELD, value: file.size, limit: MAX_ATTACHMENT_BYTES },
    );
  }
  return {
    filename: sanitizeFilename(file.name),
    mime: normalizeMime(file.type),
    bytes: Buffer.from(await file.arrayBuffer()),
  };
}

/**
 * The stored display name never carries a directory component or a control
 * character; that keeps it safe to echo in Content-Disposition and in a
 * message view regardless of what the client wrote in the part header.
 */
function sanitizeFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (cleaned.length === 0) {
    throw ApiFailure.validation('attachment filename must not be empty');
  }
  if (cleaned.length > MAX_FILENAME_LENGTH) {
    throw ApiFailure.validation(`attachment filename exceeds ${MAX_FILENAME_LENGTH} characters`);
  }
  return cleaned;
}

/** Store the media type essence; an unusable value falls back deterministically. */
function normalizeMime(raw: string): string {
  const essence = (raw.split(';')[0] ?? '').trim().toLowerCase();
  return MIME_ESSENCE.test(essence) ? essence : FALLBACK_MIME;
}

/** The upload body cap, exported so the HTTP layer reads no more than this. */
export function maxUploadEnvelopeBytes(): number {
  return MAX_ATTACHMENT_BYTES + ENVELOPE_SLACK_BYTES;
}
