import { appendFileSync } from 'node:fs';
import { migrationLedgerPath } from './data-dir.js';

export interface MigrationAuditRecord {
  from: number | null;
  to: number;
  result: 'ok' | 'failed';
  reason?: string;
  backup_path: string | null;
  started_at: string;
  finished_at: string;
}

/**
 * The audit ledger is an append-only JSONL file in the data directory; it is
 * deliberately not a database table and has no HTTP write path.
 */
export function appendMigrationRecord(
  dataDir: string,
  record: MigrationAuditRecord,
): void {
  appendFileSync(migrationLedgerPath(dataDir), `${JSON.stringify(record)}\n`, 'utf8');
}
