import type {
  AgentSkillCandidatesView,
  AgentSkillsView,
  SkillCandidateView,
  SkillInstallView,
  SkillView,
} from '@allibot/shared';

/**
 * skills 页签的纯数据助手 (#48 / D6.5).
 *
 * The panel is a renderer: the host owns the reads and writes, and these
 * helpers only translate between the wire shapes and the rendered list /
 * import controls. They are tested without a browser so the data contract
 * stays separate from React internals.
 */

/** The list row shows only the hash prefix; the full hash stays in the detail. */
export function skillHashPrefix(hash: string, length = 12): string {
  return hash.slice(0, length);
}

/** The candidates that the single-import control may offer. */
export function importableCandidates(
  candidates: AgentSkillCandidatesView | null,
): SkillCandidateView[] {
  if (candidates === null) {
    return [];
  }
  return candidates.candidates.filter(
    (candidate) => candidate.importable && !candidate.installed,
  );
}

/** The candidate named by the select, falling back to the first importable one. */
export function resolveCandidateName(
  candidates: AgentSkillCandidatesView | null,
  current: string | null,
): string | null {
  const importable = importableCandidates(candidates);
  if (current !== null && importable.some((candidate) => candidate.name === current)) {
    return current;
  }
  return importable[0]?.name ?? null;
}

/** The single-entry import body: the source is always `agents-skills`. */
export function installCandidateBody(name: string): { source: 'agents-skills'; name: string } {
  return { source: 'agents-skills', name };
}

/** `PATCH {enabled}` carries exactly the requested state. */
export function enabledPatch(enabled: boolean): { enabled: boolean } {
  return { enabled };
}

/** Whether the panel has anything to delete / toggle for the selected row. */
export function selectedSkill(
  view: AgentSkillsView | null,
  name: string | null,
): SkillView | null {
  if (view === null || view.skills.length === 0) {
    return null;
  }
  if (name === null) {
    return view.skills[0] ?? null;
  }
  return view.skills.find((skill) => skill.name === name) ?? view.skills[0] ?? null;
}

/** The installed skill named by a successful install, for the host's reload. */
export function installedSkillName(installed: SkillInstallView): string {
  return installed.skill.name;
}
