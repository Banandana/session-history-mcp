import type Database from 'better-sqlite3'
import type {
  AuditHistoryEntry,
  AuditWatermark,
  InvocationRow,
} from '../types/invocation-log'
import { RECENT_AUDITS_DENYLIST } from './param-normalizers'

export interface AuditHistoryQuery {
  readonly project?: string | undefined
  readonly toolName?: string | undefined
  /** Substring match against canonical params JSON. Loose; for surgical filters use raw SQL. */
  readonly paramsContains?: string | undefined
  /** Only audits whose lastCalledAt is after this ISO time. */
  readonly since?: string | undefined
  /** Only audits whose lastCalledAt is BEFORE this ISO time (i.e. stale). */
  readonly staleSince?: string | undefined
  readonly mode?: 'audits' | 'raw' | undefined
  readonly limit?: number | undefined
  readonly sort?: 'recent' | 'stale' | 'frequency' | undefined
}

export interface RawInvocationRecord {
  readonly id: number
  readonly toolName: string
  readonly params: Record<string, unknown>
  readonly calledAt: string
  readonly durationMs: number | null
  readonly status: 'ok' | 'error'
  readonly resultSize: number | null
  readonly projectPath: string | null
}

const SUGGESTED_SINCE_TOOLS: Record<string, string> = {
  analyze: 'from',
  context_audit: 'from',
  claude_md_effectiveness: 'from',
  search: 'from',
  semantic_search: 'from',
  get_changes: 'from',
  query_turns: 'from',
  deep_analyze: 'from',
}

export class AuditHistoryService {
  constructor(private readonly db: Database.Database) {}

  query(q: AuditHistoryQuery = {}): AuditHistoryEntry[] | RawInvocationRecord[] {
    const mode = q.mode ?? 'audits'
    if (mode === 'raw') return this.queryRaw(q)
    return this.queryAudits(q)
  }

  /**
   * Top N most-recently-touched audits for a project, with denylist applied.
   * Accepts multiple project keys (e.g. slug + filesystem path) since
   * normalizers may store either form depending on how the audit tool
   * was originally called.
   */
  recentForProject(projectKeys: readonly string[] | string, limit = 10): AuditHistoryEntry[] {
    const keys = (typeof projectKeys === 'string' ? [projectKeys] : Array.from(projectKeys))
      .filter(k => k && k.length > 0)
    if (keys.length === 0) return []

    const denylist = Array.from(RECENT_AUDITS_DENYLIST)
    const denyPlaceholders = denylist.map(() => '?').join(',')
    const keyPlaceholders = keys.map(() => '?').join(',')

    const rows = this.db.prepare(`
      SELECT * FROM audit_watermarks
      WHERE project_path IN (${keyPlaceholders})
        AND tool_name NOT IN (${denyPlaceholders})
      ORDER BY last_called_at DESC
      LIMIT ?
    `).all(...keys, ...denylist, limit) as AuditWatermarkRow[]
    return rows.map(toEntry)
  }

  private queryAudits(q: AuditHistoryQuery): AuditHistoryEntry[] {
    const conds: string[] = []
    const params: (string | number)[] = []
    if (q.project) {
      conds.push('project_path = ?')
      params.push(q.project)
    }
    if (q.toolName) {
      conds.push('tool_name = ?')
      params.push(q.toolName)
    }
    if (q.paramsContains) {
      conds.push('params_canonical_json LIKE ?')
      params.push(`%${q.paramsContains}%`)
    }
    if (q.since) {
      const ms = Date.parse(q.since)
      if (!Number.isNaN(ms)) {
        conds.push('last_called_at >= ?')
        params.push(ms)
      }
    }
    if (q.staleSince) {
      const ms = Date.parse(q.staleSince)
      if (!Number.isNaN(ms)) {
        conds.push('last_called_at < ?')
        params.push(ms)
      }
    }

    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
    const orderBy = sortClause(q.sort ?? 'recent')
    const limit = q.limit ?? 50

    const rows = this.db.prepare(`
      SELECT * FROM audit_watermarks
      ${where}
      ${orderBy}
      LIMIT ?
    `).all(...params, limit) as AuditWatermarkRow[]
    return rows.map(toEntry)
  }

  private queryRaw(q: AuditHistoryQuery): RawInvocationRecord[] {
    const conds: string[] = []
    const params: (string | number)[] = []
    if (q.project) {
      conds.push('project_path = ?')
      params.push(q.project)
    }
    if (q.toolName) {
      conds.push('tool_name = ?')
      params.push(q.toolName)
    }
    if (q.since) {
      const ms = Date.parse(q.since)
      if (!Number.isNaN(ms)) {
        conds.push('called_at >= ?')
        params.push(ms)
      }
    }
    if (q.staleSince) {
      const ms = Date.parse(q.staleSince)
      if (!Number.isNaN(ms)) {
        conds.push('called_at < ?')
        params.push(ms)
      }
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
    const limit = q.limit ?? 50

    const rows = this.db.prepare(`
      SELECT id, tool_name, params_json, called_at, duration_ms,
             result_status, result_size, project_path
      FROM tool_invocations
      ${where}
      ORDER BY called_at DESC
      LIMIT ?
    `).all(...params, limit) as InvocationRowSqlite[]

    return rows.map(r => ({
      id: r.id,
      toolName: r.tool_name,
      params: safeParse(r.params_json),
      calledAt: new Date(r.called_at).toISOString(),
      durationMs: r.duration_ms,
      status: r.result_status as 'ok' | 'error',
      resultSize: r.result_size,
      projectPath: r.project_path,
    }))
  }
}

interface AuditWatermarkRow {
  readonly tool_name: string
  readonly params_hash: string
  readonly params_canonical_json: string
  readonly project_path: string | null
  readonly first_called_at: number
  readonly last_called_at: number
  readonly call_count: number
}

interface InvocationRowSqlite {
  readonly id: number
  readonly tool_name: string
  readonly params_json: string
  readonly called_at: number
  readonly duration_ms: number | null
  readonly result_status: string
  readonly result_size: number | null
  readonly project_path: string | null
}

function sortClause(sort: 'recent' | 'stale' | 'frequency'): string {
  switch (sort) {
    case 'stale': return 'ORDER BY last_called_at ASC'
    case 'frequency': return 'ORDER BY call_count DESC, last_called_at DESC'
    case 'recent':
    default: return 'ORDER BY last_called_at DESC'
  }
}

function toEntry(row: AuditWatermarkRow): AuditHistoryEntry {
  const last = new Date(row.last_called_at)
  const first = new Date(row.first_called_at)
  const daysSince = Math.floor((Date.now() - row.last_called_at) / 86_400_000)
  const sinceParam = SUGGESTED_SINCE_TOOLS[row.tool_name]
  return {
    toolName: row.tool_name,
    paramsCanonical: safeParse(row.params_canonical_json),
    projectPath: row.project_path,
    firstCalledAt: first.toISOString(),
    lastCalledAt: last.toISOString(),
    callCount: row.call_count,
    daysSinceLastCall: daysSince,
    followUp: sinceParam ? {
      tool: row.tool_name,
      suggestedSince: last.toISOString(),
    } : undefined,
  }
}

function safeParse(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s)
    return typeof v === 'object' && v !== null ? v as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

// Re-export types for downstream consumers
export type { AuditHistoryEntry, InvocationRow, AuditWatermark }
