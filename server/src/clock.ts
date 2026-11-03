/**
 * The process clock (固定时钟). Production reads the wall clock; a test may
 * inject one fixed instant at startup (`--fixed-clock`) so retention windows
 * and occurrence timestamps are deterministic. Only Plan consumes it for now;
 * the seam is process-level like the one SSE hub, not a per-round branch.
 */
let clock: () => Date = () => new Date();

/** Inject the process clock (a fixed instant for a test, the wall clock otherwise). */
export function setClock(next: () => Date): void {
  clock = next;
}

/** Restore the wall clock; used by tests that inject and must not leak. */
export function resetClock(): void {
  clock = () => new Date();
}

/** The process clock's current instant. */
export function now(): Date {
  return clock();
}

/** The process clock's current instant as the stored UTC ISO shape. */
export function nowIso(): string {
  return clock().toISOString();
}
