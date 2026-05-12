/**
 * Typed error hierarchy for pi-code adapter operations. Pairs with neverthrow
 * Result types — callers can pattern-match on `.error` and decide whether to
 * retry, fall back, or surface to the user.
 */
export abstract class PiAdapterError extends Error {
  public abstract readonly code: string

  public constructor(message: string, public readonly cause?: unknown) {
    super(message)
    this.name = new.target.name
  }
}

export class PiSessionNotFoundError extends PiAdapterError {
  public readonly code = 'PI_SESSION_NOT_FOUND'
  public constructor(public readonly sessionId: string) {
    super(`pi session not found: ${sessionId}`)
  }
}

export class PiSessionReadError extends PiAdapterError {
  public readonly code = 'PI_SESSION_READ_ERROR'
  public constructor(public readonly path: string, cause: unknown) {
    super(`failed to read pi session at ${path}`, cause)
  }
}
