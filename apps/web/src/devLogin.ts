/**
 * Whether this build should offer the dev sign-in door.
 *
 * The api decides at startup whether `/auth/dev/start` exists (`ALLOW_DEV_LOGIN`), and
 * there is no capability route a browser could ask: the api's route table is pinned by a
 * test, so adding one is not a change this app may make on its own. Guessing from a 400
 * would mean probing an endpoint that signs people in, which is worse than a build flag.
 *
 * So the build says. In a dev build (`vite dev`, and Vitest) the door is on, because that
 * is the only provider registered today. `VITE_DEV_LOGIN` overrides it either way:
 * `"false"` keeps the door hidden in a dev build, `"true"` offers it in a built one. A
 * deployment that leaves the real providers off and the dev flag on must set it here too.
 */
export interface BuildEnv {
  readonly DEV: boolean
  readonly VITE_DEV_LOGIN?: string | undefined
}

export function devLoginAvailable(env: BuildEnv = import.meta.env): boolean {
  if (env.VITE_DEV_LOGIN === 'true') return true
  if (env.VITE_DEV_LOGIN === 'false') return false
  return env.DEV
}
