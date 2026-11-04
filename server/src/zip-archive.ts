import { inflateRawSync } from 'node:zlib';
import { ApiFailure } from './api-error.js';
import { MAX_SKILL_FILES, MAX_SKILL_TOTAL_BYTES } from './skill-limits.js';

/**
 * The minimal, safe ZIP reader used by skill upload (#48 / D6.3).
 *
 * The repository has no zip dependency, and a skill upload only needs the
 * ordinary single-disk archive shape: stored / deflate entries, UTF-8 names,
 * no encryption, no Zip64. Any unsupported or unsafe member makes the whole
 * upload a `validation_failed` error — never a partially extracted tree.
 *
 * Path rules match the directory installer: no absolute path, no drive letter,
 * no `..` segment and no symlink entry. Limits are the ticket's 200 files / 5
 * MiB extracted.
 */

interface CentralEntry {
  name: string;
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
  externalAttributes: number;
}

export interface ZipArchiveEntry {
  /** Normalized POSIX path relative to the archive root. */
  name: string;
  bytes: Buffer;
}

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

function invalid(reason: string): ApiFailure {
  return ApiFailure.validation(`invalid zip archive: ${reason}`, { field: 'upload' });
}

function findEndOfCentralDirectory(bytes: Buffer): number {
  const minimum = 22;
  if (bytes.length < minimum) {
    throw invalid('too short');
  }
  const earliest = Math.max(0, bytes.length - minimum - 0xffff);
  for (let offset = bytes.length - minimum; offset >= earliest; offset -= 1) {
    if (bytes.readUInt32LE(offset) === SIG_EOCD) {
      return offset;
    }
  }
  throw invalid('end of central directory not found');
}

function readCentralDirectory(bytes: Buffer): CentralEntry[] {
  const eocd = findEndOfCentralDirectory(bytes);
  const disk = bytes.readUInt16LE(eocd + 4);
  const centralDisk = bytes.readUInt16LE(eocd + 6);
  const count = bytes.readUInt16LE(eocd + 10);
  const centralSize = bytes.readUInt32LE(eocd + 12);
  const centralOffset = bytes.readUInt32LE(eocd + 16);
  if (disk !== 0 || centralDisk !== 0) {
    throw invalid('multi-disk archives are not supported');
  }
  if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw invalid('Zip64 archives are not supported');
  }
  if (centralOffset + centralSize > bytes.length) {
    throw invalid('central directory is out of bounds');
  }

  const entries: CentralEntry[] = [];
  let offset = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== SIG_CENTRAL) {
      throw invalid('central directory entry is malformed');
    }
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const crc = bytes.readUInt32LE(offset + 16);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const size = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const externalAttributes = bytes.readUInt32LE(offset + 38);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > bytes.length) {
      throw invalid('entry name is out of bounds');
    }
    entries.push({
      name: bytes.subarray(nameStart, nameEnd).toString('utf8'),
      flags,
      method,
      crc,
      compressedSize,
      size,
      localOffset,
      externalAttributes,
    });
    offset = nameEnd + extraLength + commentLength;
  }
  return entries;
}

/** Normalize and validate one member path; null means "directory, skip". */
function memberPath(raw: string): string | null {
  if (raw.includes('\0')) {
    throw invalid('entry name contains a NUL byte');
  }
  const unified = raw.replaceAll('\\', '/');
  if (unified.length === 0) {
    return null;
  }
  if (unified.startsWith('/') || /^[A-Za-z]:/.test(unified)) {
    throw invalid(`entry path is absolute: ${raw}`);
  }
  const parts = unified.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.length === 0) {
    return null;
  }
  if (parts.some((part) => part === '..')) {
    throw invalid(`entry path escapes the archive: ${raw}`);
  }
  if (unified.endsWith('/')) {
    return null;
  }
  return parts.join('/');
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value = CRC_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

/** Decompress and validate the whole archive before any tree is written. */
export function readZipArchive(bytes: Buffer): ZipArchiveEntry[] {
  const entries = readCentralDirectory(bytes);
  const output: ZipArchiveEntry[] = [];
  const names = new Set<string>();
  let total = 0;

  for (const entry of entries) {
    if ((entry.flags & 0x1) !== 0) {
      throw invalid('encrypted entries are not supported');
    }
    if (entry.method !== 0 && entry.method !== 8) {
      throw invalid(`unsupported compression method ${entry.method}`);
    }
    const unixMode = (entry.externalAttributes >>> 16) & 0o170000;
    if (unixMode === 0o120000) {
      throw invalid(`symlink entries are not supported: ${entry.name}`);
    }
    const name = memberPath(entry.name);
    if (name === null) {
      continue;
    }
    if (names.has(name)) {
      throw invalid(`duplicate entry: ${name}`);
    }
    names.add(name);

    if (entry.size > MAX_SKILL_TOTAL_BYTES) {
      throw ApiFailure.validation(
        `skill exceeds the ${MAX_SKILL_TOTAL_BYTES} byte extracted limit`,
        { field: 'upload', limit: MAX_SKILL_TOTAL_BYTES },
      );
    }
    total += entry.size;
    if (total > MAX_SKILL_TOTAL_BYTES) {
      throw ApiFailure.validation(
        `skill exceeds the ${MAX_SKILL_TOTAL_BYTES} byte extracted limit`,
        { field: 'upload', limit: MAX_SKILL_TOTAL_BYTES },
      );
    }
    if (output.length + 1 > MAX_SKILL_FILES) {
      throw ApiFailure.validation(`skill exceeds the ${MAX_SKILL_FILES} file limit`, {
        field: 'upload',
        limit: MAX_SKILL_FILES,
      });
    }

    if (entry.localOffset + 30 > bytes.length || bytes.readUInt32LE(entry.localOffset) !== SIG_LOCAL) {
      throw invalid(`local header is malformed: ${name}`);
    }
    const localNameLength = bytes.readUInt16LE(entry.localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(entry.localOffset + 28);
    const dataStart = entry.localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > bytes.length) {
      throw invalid(`entry bytes are out of bounds: ${name}`);
    }
    const compressed = bytes.subarray(dataStart, dataEnd);
    let data: Buffer;
    try {
      data =
        entry.method === 8
          ? inflateRawSync(compressed, { maxOutputLength: MAX_SKILL_TOTAL_BYTES })
          : Buffer.from(compressed);
    } catch {
      throw invalid(`entry cannot be decompressed: ${name}`);
    }
    if (data.length !== entry.size) {
      throw invalid(`entry size mismatch: ${name}`);
    }
    if (crc32(data) !== entry.crc) {
      throw invalid(`entry checksum mismatch: ${name}`);
    }
    output.push({ name, bytes: data });
  }
  return output;
}
