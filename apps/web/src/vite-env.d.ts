/// <reference types="vite/client" />

/**
 * The one build-time switch this app reads.
 *
 * Vite replaces `import.meta.env` at build time, so this is a compile-time decision, not a
 * request. See `src/devLogin.ts` for why the door cannot be discovered over HTTP.
 */
interface ImportMetaEnv {
  readonly VITE_DEV_LOGIN?: string
}
