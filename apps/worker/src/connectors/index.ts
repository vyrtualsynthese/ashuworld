import type { WorkerEnv } from '../config.js'
import { createStubConnector } from './stub.js'
import type { Connector } from './types.js'

/**
 * The discovery sources this process runs, in the order `PLATFORM_CONNECTORS` names them.
 *
 * `loadWorkerEnv` has already refused an unknown name and any stub request without
 * `ALLOW_STUB_CONNECTORS`, so this only builds what was asked for. An empty list is the
 * normal state of a deployment with no platform keys: the worker still drains whatever
 * the api queued, it just finds nobody itself.
 */
export function createConnectors(env: WorkerEnv): Connector[] {
  return env.PLATFORM_CONNECTORS.includes('stub') ? [createStubConnector(env.STUB_PEOPLE)] : []
}
