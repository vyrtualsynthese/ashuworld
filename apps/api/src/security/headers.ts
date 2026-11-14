import type { FastifyHelmetOptions } from '@fastify/helmet'

/**
 * The API answers JSON only. The policy is therefore deny-all, which also blocks a
 * browser from rendering an error body as a document if a proxy ever serves one.
 */
export function helmetOptions(): FastifyHelmetOptions {
  return {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'none'"],
        'frame-ancestors': ["'none'"],
        'base-uri': ["'none'"],
        'form-action': ["'none'"],
      },
    },
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    hsts: { maxAge: 31_536_000, includeSubDomains: true },
  }
}
