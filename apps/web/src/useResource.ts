import { useCallback, useEffect, useRef, useState } from 'react'

/** What a page needs to know while one request is in flight or has failed. */
export type Resource<T> =
  | { state: 'loading' }
  | { state: 'error'; error: unknown }
  | { state: 'ready'; data: T }

export interface ResourceHandle<T> {
  resource: Resource<T>
  /** Sends the request again, for a retry button or after the account changes. */
  reload: () => void
}

/**
 * Runs one request and tracks its three states.
 *
 * `load` is kept in a ref so the effect does not fire again on every render: callers pass
 * a fresh arrow function each time, and using it directly as a dependency would make an
 * endless loop of identical calls. What actually decides when to re-run is `deps`, which
 * each page states explicitly (`[handle]` for a profile, nothing for the account).
 *
 * A response that arrives after the component unmounted, or after a newer request
 * replaced it, is dropped. Without that flag a slow first request could land after the
 * retry and show the old error over the fresh data.
 *
 * The `reload` counter is part of the dependency list, so a retry is a real second request
 * rather than a render-only flag.
 */
export function useResource<T>(
  load: () => Promise<T>,
  deps: readonly unknown[],
): ResourceHandle<T> {
  const loadRef = useRef(load)
  loadRef.current = load

  const [resource, setResource] = useState<Resource<T>>({ state: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let current = true
    setResource({ state: 'loading' })
    loadRef.current().then(
      (data) => {
        if (current) setResource({ state: 'ready', data })
      },
      (error: unknown) => {
        if (current) setResource({ state: 'error', error })
      },
    )
    return () => {
      current = false
    }
    // `deps` is the caller's decision about when to re-run; the effect has no other input.
  }, [...deps, attempt])

  const reload = useCallback(() => setAttempt((count) => count + 1), [])

  return { resource, reload }
}
