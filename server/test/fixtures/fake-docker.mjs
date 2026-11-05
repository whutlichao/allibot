#!/usr/bin/env node
import { spawn } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

/**
 * Test-only fake `docker` CLI (#49). It is an injected container runtime, not a
 * second test seam: the backend spawns it exactly like the real CLI, and the
 * production code has no branch that knows it is fake.
 *
 * State is one JSON file (`ALLIBOT_FAKE_DOCKER_STATE`); every invocation is
 * appended to `ALLIBOT_FAKE_DOCKER_LOG` as one JSON line. With no state file
 * the fake reports a missing daemon, which is the deterministic default every
 * existing server suite gets.
 *
 * Bind mounts are materialized as symlinks below a per-container sandbox, and
 * `exec` translates the declared container paths to that sandbox before
 * running the command. Stdout / stderr travel back translated, so `find
 * /workspace` answers in container paths while the command really reads the
 * host project directory.
 */

const argv = process.argv.slice(2);
const statePath = process.env.ALLIBOT_FAKE_DOCKER_STATE ?? null;
const logPath = process.env.ALLIBOT_FAKE_DOCKER_LOG ?? null;

const EMPTY_STATE = {
  daemon: 'absent',
  images: [],
  pull: 'ok',
  create: 'ok',
  containers: {},
  seq: 0,
};

function readState() {
  if (statePath === null || !existsSync(statePath)) {
    return { ...EMPTY_STATE, images: [], containers: {} };
  }
  return { ...EMPTY_STATE, ...JSON.parse(readFileSync(statePath, 'utf8')) };
}

function writeState(state) {
  if (statePath === null) {
    return;
  }
  writeFileSync(statePath, JSON.stringify(state));
}

function log(entry) {
  if (logPath === null) {
    return;
  }
  appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function requireDaemon(state) {
  if (state.daemon !== 'ok') {
    fail(
      'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
    );
  }
}

function sandboxRoot() {
  return path.join(statePath === null ? '/tmp' : path.dirname(statePath), 'sandbox');
}

function prepareSandbox(state, containerId) {
  const container = state.containers[containerId];
  if (container === undefined) {
    fail(`Error response from daemon: No such container: ${containerId}`);
  }
  const root = path.join(sandboxRoot(), containerId);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  for (const mount of container.mounts) {
    const local = path.join(root, mount.target.replace(/^\//, ''));
    mkdirSync(path.dirname(local), { recursive: true });
    symlinkSync(mount.source, local);
  }
  return { root, container };
}

const PATH_TOKEN = /\/[^\s"'`;|&<>()\\]+/g;

function sandboxPath(root, mount) {
  return path.join(root, mount.target.replace(/^\//, ''));
}

/** Rewrite whole path tokens whose longest mount prefix is a container path. */
function rewriteTokens(text, resolve) {
  return text.replace(PATH_TOKEN, (token) => resolve(token) ?? token);
}

function translate(text, root, mounts) {
  return rewriteTokens(text, (token) => {
    let best = null;
    for (const mount of mounts) {
      if (token === mount.target || token.startsWith(`${mount.target}/`)) {
        if (best === null || mount.target.length > best.target.length) {
          best = mount;
        }
      }
    }
    if (best === null) {
      return null;
    }
    return sandboxPath(root, best) + token.slice(best.target.length);
  });
}

/** Map sandbox / host paths in a command's output back to container paths. */
function outputTranslate(text, root, mounts) {
  return rewriteTokens(text, (token) => {
    let best = null;
    for (const mount of mounts) {
      const sandbox = sandboxPath(root, mount);
      const sources = [mount.source];
      try {
        sources.push(realpathSync(mount.source));
      } catch {
        // A missing source is a create-time problem, not a translation.
      }
      for (const candidate of [sandbox, ...sources]) {
        if (token === candidate || token.startsWith(`${candidate}/`)) {
          if (best === null || candidate.length > best.length) {
            best = candidate;
            var bestTarget = mount.target;
          }
        }
      }
    }
    if (best === null) {
      return null;
    }
    return bestTarget + token.slice(best.length);
  });
}

function command(method) {
  if (method === 'version') {
    const state = readState();
    log({ op: 'version' });
    requireDaemon(state);
    process.stdout.write('27.0.0-fake\n');
    return;
  }
  if (method === 'image' && argv[1] === 'inspect') {
    const state = readState();
    const ref = argv[2];
    requireDaemon(state);
    const present = state.images.includes(ref);
    log({ op: 'image-inspect', ref, present });
    if (!present) {
      fail(`Error response from daemon: No such image: ${ref}`);
    }
    process.stdout.write(`sha256:fake-${Buffer.from(ref).toString('hex').slice(0, 12)}\n`);
    return;
  }
  if (method === 'pull') {
    const state = readState();
    const ref = argv[1];
    requireDaemon(state);
    log({ op: 'pull', ref, result: state.pull });
    if (state.pull === 'fail') {
      fail('Error response from daemon: pull access denied, repository does not exist');
    }
    if (state.pull === 'ok' && !state.images.includes(ref)) {
      state.images.push(ref);
      writeState(state);
    }
    process.stdout.write(`fake pull ${ref}\n`);
    return;
  }
  if (method === 'create') {
    const state = readState();
    requireDaemon(state);
    const name = optionValue('--name') ?? `fake-${state.seq + 1}`;
    const labels = {};
    const mounts = [];
    let network = null;
    let index = 1;
    while (index < argv.length) {
      const token = argv[index];
      if (token === '--name') {
        index += 2;
        continue;
      }
      if (token === '--label') {
        const pair = argv[index + 1];
        const split = pair.indexOf('=');
        labels[pair.slice(0, split)] = pair.slice(split + 1);
        index += 2;
        continue;
      }
      if (token === '--mount') {
        mounts.push(parseMount(argv[index + 1]));
        index += 2;
        continue;
      }
      if (token === '--network') {
        network = argv[index + 1];
        index += 2;
        continue;
      }
      if (token === '--workdir') {
        index += 2;
        continue;
      }
      break;
    }
    const image = argv[index];
    const commandRest = argv.slice(index + 1);
    state.seq += 1;
    const id = `fake-${state.seq}`;
    log({
      op: 'create',
      id,
      name,
      image,
      labels,
      mounts,
      network,
      command: commandRest,
      result: state.create,
    });
    if (state.create === 'fail') {
      fail('Error response from daemon: failed to create task for container: no such file or directory');
    }
    state.containers[id] = { name, image, labels, mounts, command: commandRest };
    writeState(state);
    process.stdout.write(`${id}\n`);
    return;
  }
  if (method === 'ps') {
    const state = readState();
    requireDaemon(state);
    const filterIndex = argv.indexOf('--filter');
    const filter = filterIndex === -1 ? '' : argv[filterIndex + 1];
    const [key, value] = filter.replace(/^label=/, '').split('=');
    const ids = Object.entries(state.containers)
      .filter(([, container]) => container.labels[key] === value)
      .map(([id]) => id);
    log({ op: 'ps', filter, ids });
    process.stdout.write(ids.length === 0 ? '' : `${ids.join('\n')}\n`);
    return;
  }
  if (method === 'stop') {
    const state = readState();
    requireDaemon(state);
    const id = argv[1];
    log({ op: 'stop', container: id });
    if (state.containers[id] === undefined) {
      fail(`Error response from daemon: No such container: ${id}`);
    }
    process.stdout.write(`${id}\n`);
    return;
  }
  if (method === 'rm') {
    const state = readState();
    requireDaemon(state);
    const id = argv[argv.length - 1];
    log({ op: 'rm', container: id });
    if (state.containers[id] === undefined && !argv.includes('-f')) {
      fail(`Error response from daemon: No such container: ${id}`);
    }
    delete state.containers[id];
    writeState(state);
    process.stdout.write(`${id}\n`);
    return;
  }
  if (method === 'exec') {
    execute();
    return;
  }
  fail(`fake docker: unsupported command ${argv.join(' ')}`);
}

function optionValue(name) {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1];
}

function parseMount(spec) {
  const parsed = { source: '', target: '', read_only: false };
  for (const part of spec.split(',')) {
    if (part.startsWith('source=')) {
      parsed.source = part.slice('source='.length);
    } else if (part.startsWith('target=')) {
      parsed.target = part.slice('target='.length);
    } else if (part === 'readonly' || part === 'readonly=true') {
      parsed.read_only = true;
    }
  }
  return parsed;
}

function execute() {
  const state = readState();
  requireDaemon(state);
  const env = {};
  let workdir = null;
  let index = 1;
  while (index < argv.length) {
    const token = argv[index];
    if (token === '-i' || token === '-t' || token === '-it') {
      index += 1;
      continue;
    }
    if (token === '-w') {
      workdir = argv[index + 1];
      index += 2;
      continue;
    }
    if (token === '-e') {
      const pair = argv[index + 1];
      const split = pair.indexOf('=');
      env[pair.slice(0, split)] = pair.slice(split + 1);
      index += 2;
      continue;
    }
    break;
  }
  const containerId = argv[index];
  const commandArgv = argv.slice(index + 1);
  if (commandArgv.length === 0) {
    fail('fake docker: exec needs a command');
  }
  const { root, container } = prepareSandbox(state, containerId);
  const translatedArgv = commandArgv.map((value) => translate(value, root, container.mounts));
  const fallbackPath = `${path.dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`;
  const childEnv = { PATH: fallbackPath, ...env };
  const cwd =
    workdir === null
      ? path.join(root, 'workspace')
      : translate(workdir, root, container.mounts);
  if (!existsSync(cwd)) {
    fail(`OCI runtime exec failed: exec failed: chdir to cwd ("${workdir}") set in config.json failed: no such file or directory`);
  }
  log({
    op: 'exec',
    container: containerId,
    argv: commandArgv,
    cwd: workdir,
    env_keys: Object.keys(env).sort(),
  });
  const child = spawn(translatedArgv[0], translatedArgv.slice(1), {
    cwd,
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // Line-buffered output translation: an interactive stdio MCP server's
  // newline-delimited JSON-RPC responses are forwarded promptly, and buffered
  // commands still get their container paths translated.
  let stdoutRest = '';
  let stderrRest = '';
  child.stdout.on('data', (chunk) => {
    stdoutRest += chunk.toString('utf8');
    let newline = stdoutRest.indexOf('\n');
    while (newline !== -1) {
      const line = stdoutRest.slice(0, newline);
      stdoutRest = stdoutRest.slice(newline + 1);
      process.stdout.write(`${outputTranslate(line, root, container.mounts)}\n`);
      newline = stdoutRest.indexOf('\n');
    }
  });
  child.stderr.on('data', (chunk) => {
    stderrRest += chunk.toString('utf8');
    let newline = stderrRest.indexOf('\n');
    while (newline !== -1) {
      const line = stderrRest.slice(0, newline);
      stderrRest = stderrRest.slice(newline + 1);
      process.stderr.write(`${outputTranslate(line, root, container.mounts)}\n`);
      newline = stderrRest.indexOf('\n');
    }
  });
  child.once('error', (error) => {
    fail(`fake docker exec: ${error.message}`);
  });
  process.stdin.on('data', (chunk) => {
    child.stdin.write(chunk);
  });
  process.stdin.on('end', () => {
    child.stdin.end();
  });
  child.once('close', (code) => {
    if (stdoutRest.length > 0) {
      process.stdout.write(outputTranslate(stdoutRest, root, container.mounts));
    }
    if (stderrRest.length > 0) {
      process.stderr.write(outputTranslate(stderrRest, root, container.mounts));
    }
    process.exit(code === null ? 1 : code);
  });
}

command(argv[0] ?? '');
