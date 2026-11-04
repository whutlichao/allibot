import type Database from 'better-sqlite3';
import { tFromDb } from './copy.js';

/**
 * 分派摘录 (TeamAssignment reply excerpt, #39 / D3.4): a `team_assignment` row
 * keeps at most 2000 Unicode code points of the member's output, marked as
 * truncated when the full output is longer. The full output goes back to the
 * leader in the tool result and is never stored.
 *
 * Counting code points (not UTF-16 units) is what keeps an emoji or a CJK
 * surrogate pair one unit; `Array.from` iterates code points.
 */
export const TEAM_ASSIGNMENT_EXCERPT_LIMIT = 2000;

export function codepointLength(text: string): number {
  return Array.from(text).length;
}

/**
 * The stored excerpt of one member output: the first 2000 code points plus the
 * readable truncation marker when anything was cut. A short output is stored
 * verbatim.
 */
export function truncateTeamAssignmentExcerpt(
  db: Database.Database,
  output: string,
): string {
  const trimmed = output.trim();
  const points = Array.from(trimmed);
  if (points.length <= TEAM_ASSIGNMENT_EXCERPT_LIMIT) {
    return trimmed;
  }
  return (
    points.slice(0, TEAM_ASSIGNMENT_EXCERPT_LIMIT).join('') +
    tFromDb(db, 'team.assignment.truncated')
  );
}
