/**
 * Types for the MCP tool-invocation log and audit-watermark system.
 *
 * The log records every MCP tool call (raw firehose). The watermark table
 * is a materialized view of "last successful call per (tool, canonical params)"
 * so agents can ask "when did I last audit X" without scanning the firehose.
 */

export type InvocationStatus = 'ok' | 'error'

/**
 * A normalizer's view of a tool invocation. Two calls with the same canonical
 * shape are considered "the same audit" and share a watermark row.
 *
 * Rule: normalize the SHAPE, not the time anchor. e.g. `{ days: 7 }` and
 * `{ days: 30 }` collapse to the same canonical shape (a rolling window),
 * but `{ since: "2026-04-20" }` is a different shape (pinned date).
 */
export interface CanonicalParams {
  /** The audit-distinct subset of params, with sorted keys and defaults filled. */
  readonly shape: Record<string, unknown>
  /** Optional project slug derived from params, denormalized onto the watermark row. */
  readonly projectPath?: string
}

/**
 * Per-tool function that converts raw input into a canonical shape.
 * Returning null means "this call doesn't deserve a watermark" — used by
 * lookup-style tools that opt out of the audit table.
 */
export type ParamNormalizer = (input: Record<string, unknown>) => CanonicalParams | null

/** Raw row in `tool_invocations` — one per MCP call. */
export interface InvocationRow {
  readonly id: number
  readonly toolName: string
  readonly paramsJson: string
  readonly paramsHash: string
  readonly calledAt: number
  readonly durationMs: number | null
  readonly resultStatus: InvocationStatus
  readonly resultSize: number | null
  readonly callerSession: string | null
  readonly projectPath: string | null
}

/** Materialized "last successful call per (tool, canonical params)". */
export interface AuditWatermark {
  readonly toolName: string
  readonly paramsHash: string
  readonly paramsCanonicalJson: string
  readonly projectPath: string | null
  readonly firstCalledAt: number
  readonly lastCalledAt: number
  readonly callCount: number
}

/** Output shape returned by `get_audit_history` and `get_project.recentAudits`. */
export interface AuditHistoryEntry {
  readonly toolName: string
  readonly paramsCanonical: Record<string, unknown>
  readonly projectPath: string | null
  readonly firstCalledAt: string
  readonly lastCalledAt: string
  readonly callCount: number
  readonly daysSinceLastCall: number
  /** Compact suggestion telling the agent how to fill the gap since lastCalledAt. */
  readonly followUp?: {
    readonly tool: string
    readonly suggestedSince: string
  }
}

/** Input record submitted to the logger after each MCP call. */
export interface InvocationRecord {
  readonly toolName: string
  readonly rawParams: unknown
  readonly status: InvocationStatus
  readonly durationMs: number
  readonly resultSize: number
  readonly calledAt?: number
  readonly callerSession?: string | null
}
