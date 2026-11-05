import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { WorkspaceFailureReason } from '@allibot/shared';
import type {
  DockerContainerSpec,
  DockerExecResult,
  DockerMount,
  DockerRuntime,
} from './docker-runtime.js';

/**
 * Docker 工作区后端 (#49 / D5.3 / D5.7 / ADR-0006).
 *
 * One process-level manager owns the container lifecycle:
 * - lazily create one container per `(member_id, target_id)` the first time a
 *   Docker round needs the workspace, reuse it inside this process only;
 * - never share a container across targets or processes;
 * - stop and remove every container this process created on shutdown;
 * - remove residual containers carrying this application's marker at startup.
 *
 * It also carries the read-only Docker availability snapshot behind
 * `GET /api/workspace.workspace_runtime` and the per-target
 * `workspace_status` reason. Availability is a target-context fact: the
 * manager never writes a global status point.
 *
 * Image pulling is consent-gated: an image that is not local is only pulled
 * after the one-time `('docker', image_ref)` row exists (v21
 * `remote_consent_scope`, D5.3 / D6.1). Without it the target reads
 * `docker-consent-missing`; with it and a failed pull it reads
 * `docker-image-missing`.
 */

/** The default image reference (process-level `allibot_DOCKER_IMAGE`). */
export const DEFAULT_DOCKER_IMAGE = 'node:22-bookworm-slim';

/** The marker label every container this application creates carries. */
export const DOCKER_MARKER_LABEL = 'allibot.workspace';

export interface DockerRuntimeView {
  /** The daemon is reachable and the configured image is present locally. */
  available: boolean;
  /** The process-level image reference; never a credential. */
  image: string;
  reason: WorkspaceFailureReason | null;
}

export interface DockerTargetStatus {
  available: boolean;
  reason: WorkspaceFailureReason | null;
}

export interface DockerWorkspaceManagerOptions {
  runtime: DockerRuntime;
  image: string;
  dataDir: string;
  /** The v21 `('docker', image_ref)` consent fact for this image. */
  hasImageConsent: (imageRef: string) => boolean;
}

interface ContainerRecord {
  id: string;
  root: string;
}

interface FailureRecord {
  reason: WorkspaceFailureReason;
  detail: string | null;
}

/** The container handle a Docker round's tool faces execute through. */
export interface DockerContainerHandle {
  id: string;
  /** The host project root the container mounts at `/workspace`. */
  root: string;
  exec(
    argv: readonly string[],
    options?: {
      workdir?: string;
      env?: Record<string, string>;
      input?: string;
      maxOutputBytes?: number;
    },
  ): Promise<DockerExecResult>;
  spawn(
    argv: readonly string[],
    options?: { workdir?: string; env?: Record<string, string> },
  ): ChildProcessWithoutNullStreams;
}

/** One readable Docker workspace failure; the round never falls back to local. */
export class DockerWorkspaceError extends Error {
  constructor(
    readonly reason: WorkspaceFailureReason,
    readonly detail: string | null,
  ) {
    super(detail === null ? reason : `${reason}: ${detail}`);
    this.name = 'DockerWorkspaceError';
  }
}

export class DockerWorkspaceManager {
  private readonly runtime: DockerRuntime;
  private readonly image: string;
  private readonly marker: string;
  private readonly hasImageConsent: (imageRef: string) => boolean;
  private daemonOk = false;
  private daemonDetail: string | null = null;
  private imagePresent = false;
  private readonly containers = new Map<string, ContainerRecord>();
  private readonly failures = new Map<string, FailureRecord>();
  private nextContainer = 1;

  constructor(options: DockerWorkspaceManagerOptions) {
    this.runtime = options.runtime;
    this.image = options.image;
    this.hasImageConsent = options.hasImageConsent;
    // The marker is per application instance (its data directory): a second
    // allibot on the same host never removes this instance's containers.
    const digest = createHash('sha256')
      .update(path.resolve(options.dataDir))
      .digest('hex')
      .slice(0, 16);
    this.marker = `${DOCKER_MARKER_LABEL}=${digest}`;
  }

  /** The marker label value this process filters / labels containers with. */
  get markerLabel(): string {
    return this.marker;
  }

  /** The process-level image reference. */
  get imageRef(): string {
    return this.image;
  }

  /** The daemon / image snapshot the human face reads (no side effects). */
  runtimeView(): DockerRuntimeView {
    if (!this.daemonOk) {
      return { available: false, image: this.image, reason: 'docker-unavailable' };
    }
    if (this.imagePresent) {
      return { available: true, image: this.image, reason: null };
    }
    return {
      available: false,
      image: this.image,
      reason: this.hasImageConsent(this.image)
        ? 'docker-image-missing'
        : 'docker-consent-missing',
    };
  }

  /**
   * The target-context Docker status (D5.7). It is a pure read over the
   * process snapshot plus the per-target failure record; it never creates a
   * container, pulls an image or writes a status point.
   */
  statusFor(key: { memberId: string; targetId: string }): DockerTargetStatus {
    const failure = this.failures.get(this.keyOf(key));
    if (failure !== undefined) {
      return { available: false, reason: failure.reason };
    }
    if (!this.daemonOk) {
      return { available: false, reason: 'docker-unavailable' };
    }
    if (this.imagePresent) {
      return { available: true, reason: null };
    }
    return {
      available: false,
      reason: this.hasImageConsent(this.image)
        ? 'docker-image-missing'
        : 'docker-consent-missing',
    };
  }

  /** The readable failure detail for a target, for round reasons only. */
  failureDetail(key: { memberId: string; targetId: string }): string | null {
    return this.failures.get(this.keyOf(key))?.detail ?? null;
  }

  /**
   * Startup: refresh the availability snapshot and remove residual containers
   * carrying this application's marker (a previous process that crashed).
   * A missing daemon is a readable state, not a startup failure.
   */
  async initialize(): Promise<void> {
    await this.refreshAvailability();
    if (!this.daemonOk) {
      return;
    }
    const residual = await this.runtime.listMarkedContainers(this.marker).catch(() => []);
    for (const container of residual) {
      await this.runtime.stopContainer(container.id).catch(() => undefined);
      await this.runtime.removeContainer(container.id).catch(() => undefined);
    }
  }

  /** Refresh the daemon / image snapshot (startup and before a Docker round). */
  async refreshAvailability(): Promise<void> {
    const ping = await this.runtime.ping();
    this.daemonOk = ping.ok;
    this.daemonDetail = ping.detail;
    if (!ping.ok) {
      this.imagePresent = false;
      return;
    }
    const image = await this.runtime.inspectImage(this.image);
    if (image.detail !== null && !image.present) {
      // inspect could not answer for a reason other than a missing image (for
      // example the daemon went away between version and inspect).
      this.daemonOk = false;
      this.daemonDetail = image.detail;
      this.imagePresent = false;
      return;
    }
    this.imagePresent = image.present;
  }

  /**
   * Ensure the container for `(member_id, target_id)` exists and return its
   * handle (D5.3). The first Docker round that needs the workspace creates it;
   * later rounds reuse it inside this process. A configuration change of the
   * project root recreates the container because `/workspace` is a fixed mount.
   * A failure is recorded per target and becomes that target's
   * `workspace_status` reason; there is no local fallback.
   */
  async prepare(options: {
    memberId: string;
    targetId: string;
    projectRoot: string;
    memberHome: string;
    globalSkillsRoot: string;
  }): Promise<DockerContainerHandle> {
    const key = this.keyOf(options);
    const root = canonicalPath(options.projectRoot);
    const cached = this.containers.get(key);
    if (cached !== undefined && cached.root === root) {
      return this.handleFor(cached);
    }
    if (cached !== undefined) {
      // The project root moved: /workspace is a fixed mount, so the container
      // is not the same workspace any more.
      await this.runtime.stopContainer(cached.id).catch(() => undefined);
      await this.runtime.removeContainer(cached.id).catch(() => undefined);
      this.containers.delete(key);
    }

    await this.refreshAvailability();
    if (!this.daemonOk) {
      throw this.recordFailure(key, 'docker-unavailable', this.daemonDetail);
    }
    if (!this.imagePresent) {
      if (!this.hasImageConsent(this.image)) {
        throw this.recordFailure(key, 'docker-consent-missing', null);
      }
      const pulled = await this.runtime.pullImage(this.image);
      if (!pulled.ok) {
        throw this.recordFailure(key, 'docker-image-missing', pulled.detail);
      }
      const afterPull = await this.runtime.inspectImage(this.image);
      if (!afterPull.present) {
        throw this.recordFailure(key, 'docker-image-missing', afterPull.detail);
      }
      this.imagePresent = true;
    }

    const spec = dockerContainerSpec({
      name: this.containerName(options),
      image: this.image,
      marker: this.marker,
      memberId: options.memberId,
      targetId: options.targetId,
      projectRoot: root,
      memberHome: canonicalPath(options.memberHome),
      globalSkillsRoot: canonicalPath(options.globalSkillsRoot),
    });
    const created = await this.runtime.createContainer(spec);
    if (!created.ok || created.id === null) {
      throw this.recordFailure(key, 'docker-unavailable', created.detail);
    }
    this.failures.delete(key);
    const record: ContainerRecord = { id: created.id, root };
    this.containers.set(key, record);
    return this.handleFor(record);
  }

  private handleFor(record: ContainerRecord): DockerContainerHandle {
    const runtime = this.runtime;
    return {
      id: record.id,
      root: record.root,
      async exec(argv, options = {}) {
        return await runtime.exec({
          containerId: record.id,
          argv,
          workdir: options.workdir,
          env: options.env,
          input: options.input,
          maxOutputBytes: options.maxOutputBytes,
        });
      },
      spawn(argv, options = {}) {
        return runtime.spawnExec({
          containerId: record.id,
          argv,
          workdir: options.workdir,
          env: options.env,
        });
      },
    };
  }

  private recordFailure(
    key: string,
    reason: WorkspaceFailureReason,
    detail: string | null,
  ): DockerWorkspaceError {
    this.failures.set(key, { reason, detail });
    return new DockerWorkspaceError(reason, detail);
  }

  private containerName(options: { memberId: string; targetId: string }): string {
    const suffix = this.nextContainer;
    this.nextContainer += 1;
    const safe = (value: string): string => value.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 12);
    return `allibot-ws-${safe(options.memberId)}-${safe(options.targetId)}-${process.pid}-${suffix}`;
  }

  /** Stop and remove every container this process created (process exit). */
  async shutdown(): Promise<void> {
    for (const record of this.containers.values()) {
      await this.runtime.stopContainer(record.id).catch(() => undefined);
      await this.runtime.removeContainer(record.id).catch(() => undefined);
    }
    this.containers.clear();
  }

  private keyOf(key: { memberId: string; targetId: string }): string {
    return `${key.memberId}\u0000${key.targetId}`;
  }
}

let currentManager: DockerWorkspaceManager | null = null;

/** Wire the one process-level manager the CLI created; tests never call it. */
export function setDockerWorkspaceManager(manager: DockerWorkspaceManager | null): void {
  currentManager = manager;
}

/** The process manager, or null before startup / in a migration-only process. */
export function getDockerWorkspaceManager(): DockerWorkspaceManager | null {
  return currentManager;
}

/** The `workspace_runtime` reading; a missing manager is "unavailable". */
export function readWorkspaceRuntime(env: NodeJS.ProcessEnv = process.env): {
  docker: DockerRuntimeView;
} {
  const manager = currentManager;
  if (manager === null) {
    return {
      docker: {
        available: false,
        image: dockerImageRef(env),
        reason: 'docker-unavailable',
      },
    };
  }
  return { docker: manager.runtimeView() };
}

/** The process-level image reference (`allibot_DOCKER_IMAGE`, default node slim). */
export function dockerImageRef(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.allibot_DOCKER_IMAGE;
  return value !== undefined && value.trim().length > 0 ? value.trim() : DEFAULT_DOCKER_IMAGE;
}

/**
 * The tool process environment inside the container (D5.3 / D5.4): the
 * allowlist plus declared `env_names`, with `HOME` at the read-only member home
 * mount and `PWD` at the working directory. Model provider keys and web
 * credentials are never in this environment. The image's own `PATH` is
 * inherited from the container; a host `PATH` would name host-only tools.
 */
export const CONTAINER_ENV_ALLOWLIST = [
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'SHELL',
  'USER',
  'LOGNAME',
] as const;

export function containerToolEnvironment(
  hostEnv: NodeJS.ProcessEnv,
  envNames: readonly string[],
  cwd = '/workspace',
): Record<string, string> {
  const env: Record<string, string> = { HOME: '/agent-home', PWD: cwd, TMPDIR: '/tmp' };
  for (const name of CONTAINER_ENV_ALLOWLIST) {
    const value = hostEnv[name];
    if (value !== undefined && value.length > 0) {
      env[name] = value;
    }
  }
  for (const name of envNames) {
    const value = hostEnv[name];
    if (value !== undefined && value.length > 0) {
      env[name] = value;
    }
  }
  return env;
}

function canonicalPath(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

/** The three fixed mounts; the data directory is never among them (D5.3). */
export function dockerMounts(options: {
  projectRoot: string;
  memberHome: string;
  globalSkillsRoot: string;
}): DockerMount[] {
  return [
    { source: options.projectRoot, target: '/workspace', readOnly: false },
    { source: options.memberHome, target: '/agent-home', readOnly: true },
    { source: options.globalSkillsRoot, target: '/skills', readOnly: true },
  ];
}

/** One container's creation spec; exported for the manager's own tests. */
export function dockerContainerSpec(options: {
  name: string;
  image: string;
  marker: string;
  memberId: string;
  targetId: string;
  projectRoot: string;
  memberHome: string;
  globalSkillsRoot: string;
}): DockerContainerSpec {
  return {
    name: options.name,
    image: options.image,
    labels: {
      [DOCKER_MARKER_LABEL]: options.marker.split('=')[1] ?? options.marker,
      'allibot.member': options.memberId,
      'allibot.target': options.targetId,
    },
    mounts: dockerMounts(options),
    network: 'none',
    // M2 does not build images: the image only needs a long-lived `/bin/sh`
    // compatible process so the container stays up between execs.
    command: ['sleep', 'infinity'],
  };
}
