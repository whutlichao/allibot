import type Database from 'better-sqlite3';
import { CopilotRuntime, createCopilotRuntimeHandler } from '@copilotkit/runtime/v2';
import type { CopilotRuntimeFetchHandler } from '@copilotkit/runtime/v2';
import { createCopilotNodeHandler } from '@copilotkit/runtime/v2/node';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AllibotAgent, ORCHESTRATION_AGENT_ID } from './agui-agent.js';
import type { OrchestrationRuntime } from './rounds.js';

/** The multi-route CopilotKit base path the frontend provider points at. */
export const COPILOTKIT_BASE_PATH = '/api/copilotkit';

/**
 * The CopilotKit v2 wiring: one `allibot` orchestration agent behind the
 * multi-route fetch handler (GET / POST / PATCH / DELETE), adapted to the
 * node:http server. `useSingleEndpoint={false}` on the provider matches this
 * handler shape.
 *
 * `@copilotkit/runtime@1.83.0` pins `@ag-ui/client@1.0.2`, and this workspace
 * declares the same `@ag-ui/client@1.0.2` directly; the runtime's
 * `AbstractAgent` type is nominal (a private field), so the dependency tree
 * still carries second copies under other middleware packages. The
 * bridge is typed structurally here and the two copies agree at runtime, which
 * the process-level contract test exercises end to end.
 */
export function createCopilotKitHandler(
  db: Database.Database,
  orchestration: OrchestrationRuntime,
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  const agents: ConstructorParameters<typeof CopilotRuntime>[0]['agents'] = {
    [ORCHESTRATION_AGENT_ID]: new AllibotAgent(db, orchestration),
  };
  const runtime = new CopilotRuntime({ agents });
  const fetchHandler: CopilotRuntimeFetchHandler = createCopilotRuntimeHandler({
    runtime,
    basePath: COPILOTKIT_BASE_PATH,
  });
  return createCopilotNodeHandler(fetchHandler);
}

/** True when a pathname belongs to the CopilotKit handler's base path. */
export function isCopilotKitPath(pathname: string): boolean {
  return pathname === COPILOTKIT_BASE_PATH || pathname.startsWith(`${COPILOTKIT_BASE_PATH}/`);
}
