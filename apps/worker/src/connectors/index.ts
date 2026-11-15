import type { Pool } from 'pg'
import type { WorkerEnv } from '../config.js'
import { createStubConnector } from './stub.js'
import { createTwitchConnector } from './twitch.js'
import type { Connector } from './types.js'

/**
 * The discovery sources this process runs, in the order `PLATFORM_CONNECTORS` names them.
 *
 * `loadWorkerEnv` has already refused an unknown name, any stub request without
 * `ALLOW_STUB_CONNECTORS`, and an incomplete Twitch credential set when `'twitch'` is
 * listed, so this only builds what was asked for. An empty list is the normal state of a
 * deployment with no platform keys: the worker still drains whatever the api queued, it
 * just finds nobody itself.
 *
 * The pool is threaded through because the Twitch connector reads the sealed channel grant
 * from `platform_tokens`; the stub ignores it.
 */
export function createConnectors(env: WorkerEnv, pool: Pool): Connector[] {
  return env.PLATFORM_CONNECTORS.map((name) => {
    switch (name) {
      case 'stub':
        return createStubConnector(env.STUB_PEOPLE)
      case 'twitch':
        return createTwitchConnector({ pool, env })
    }
  })
}
