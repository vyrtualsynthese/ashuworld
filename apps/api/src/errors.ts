/**
 * The one owner of the failure body.
 *
 * Every non-2xx response in the service is this shape: the error handler, the 404
 * handler and the health probe all build their body here, so a route cannot quietly
 * invent a second one.
 */
export interface ErrorEnvelope {
  error: {
    code: string
    message: string
  }
}

export function errorBody(code: string, message: string): ErrorEnvelope {
  return { error: { code, message } }
}
