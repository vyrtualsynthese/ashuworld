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

/**
 * The 404 body, owned here rather than in the route that answers it.
 *
 * Both the not-found handler and a route that cannot find the row a caller named must
 * answer with the same bytes. Two copies of this text would drift, and a caller could
 * then tell "no such route" from "no such identity" — the very distinction a scoped
 * lookup exists to hide.
 */
export const NOT_FOUND_MESSAGE = 'the requested resource does not exist'

export function notFoundBody(): ErrorEnvelope {
  return errorBody('not_found', NOT_FOUND_MESSAGE)
}
