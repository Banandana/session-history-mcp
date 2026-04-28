import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { InvocationRecord } from '../types/invocation-log'
import { getNormalizer } from './param-normalizers'

/**
 * Records every MCP tool call to `tool_invocations` and upserts a matching
 * row in `audit_watermarks` if the tool has a registered normalizer and the
 * call succeeded.
 *
 * Logging failures never propagate — telemetry must never break a real
 * tool call. Errors are written to stderr and swallowed.
 */
export class ToolInvocationLogger {
  private readonly insertInvocation: Database.Statement
  private readonly upsertWatermark: Database.Statement

  constructor(private readonly db: Database.Database) {
    this.insertInvocation = this.db.prepare(`
      INSERT INTO tool_invocations (
        tool_name, params_json, params_hash, called_at, duration_ms,
        result_status, result_size, caller_session, project_path
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    this.upsertWatermark = this.db.prepare(`
      INSERT INTO audit_watermarks (
        tool_name, params_hash, params_canonical_json, project_path,
        first_called_at, last_called_at, call_count
      ) VALUES (?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(tool_name, params_hash) DO UPDATE SET
        last_called_at = excluded.last_called_at,
        call_count = call_count + 1,
        project_path = COALESCE(audit_watermarks.project_path, excluded.project_path)
    `)
  }

  record(rec: InvocationRecord): void {
    try {
      this.recordImpl(rec)
    } catch (err) {
      // Telemetry must never break a real call. Surface to stderr only.
      console.error('[invocation-logger] record failed:', err)
    }
  }

  private recordImpl(rec: InvocationRecord): void {
    const calledAt = rec.calledAt ?? Date.now()
    const rawObj = isPlainObject(rec.rawParams) ? rec.rawParams : {}
    const paramsJson = safeStringify(rawObj)

    const normalizer = getNormalizer(rec.toolName)
    const canonical = normalizer ? normalizer(rawObj) : null
    const canonicalJson = canonical ? canonicalStringify(canonical.shape) : paramsJson
    const paramsHash = sha1Hex(`${rec.toolName}:${canonicalJson}`)
    const projectPath = canonical?.projectPath ?? null

    this.insertInvocation.run(
      rec.toolName,
      paramsJson,
      paramsHash,
      calledAt,
      rec.durationMs,
      rec.status,
      rec.resultSize,
      rec.callerSession ?? null,
      projectPath,
    )

    // Watermark only on successful calls AND only if the tool has a normalizer.
    if (rec.status === 'ok' && canonical) {
      this.upsertWatermark.run(
        rec.toolName,
        paramsHash,
        canonicalJson,
        projectPath,
        calledAt,
        calledAt,
      )
    }
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return '{}'
  }
}

/** Stable JSON: object keys sorted recursively. */
export function canonicalStringify(v: unknown): string {
  return JSON.stringify(canonicalize(v))
}

function canonicalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalize)
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v).sort()) out[k] = canonicalize(v[k])
    return out
  }
  return v
}

function sha1Hex(s: string): string {
  return createHash('sha1').update(s).digest('hex')
}
