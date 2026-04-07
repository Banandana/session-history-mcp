import type Database from 'better-sqlite3'
import type {
  ContextAuditDetail,
  ContextAuditFilters,
  CostBreakdownSummary,
  CostBreakdownFull,
  CostPeriod,
  CostSessionDetail,
  SessionRef,
  TemporalGrouping,
} from '../types/context-audit'

interface SqlFilter {
  readonly conditions: string[]
  readonly params: (string | number)[]
}

interface CostBreakdownOptions {
  readonly filters?: ContextAuditFilters
  readonly groupBy?: TemporalGrouping
  readonly limit?: number
}

const STRFTIME_FORMATS: Record<TemporalGrouping, string> = {
  day: '%Y-%m-%d',
  week: '%Y-W%W',
  month: '%Y-%m',
}

export class ContextAuditor {
  constructor(private readonly db: Database.Database) {}

  buildSessionFilters(filters?: ContextAuditFilters, prefix = 's'): SqlFilter {
    const conditions: string[] = []
    const params: (string | number)[] = []

    if (!filters) return { conditions, params }

    if (filters.projectSlug) {
      conditions.push(`${prefix}.project_slug = ?`)
      params.push(filters.projectSlug)
    }

    if (filters.dateRange?.from) {
      conditions.push(`${prefix}.started_at >= ?`)
      params.push(filters.dateRange.from)
    }

    if (filters.dateRange?.to) {
      conditions.push(`${prefix}.started_at <= ?`)
      params.push(filters.dateRange.to)
    }

    if (filters.minTokens != null) {
      conditions.push(`${prefix}.total_tokens >= ?`)
      params.push(filters.minTokens)
    }

    if (filters.maxTokens != null) {
      conditions.push(`${prefix}.total_tokens <= ?`)
      params.push(filters.maxTokens)
    }

    if (filters.minCost != null) {
      conditions.push(`${prefix}.cost_usd >= ?`)
      params.push(filters.minCost)
    }

    if (filters.maxCost != null) {
      conditions.push(`${prefix}.cost_usd <= ?`)
      params.push(filters.maxCost)
    }

    if (filters.minCacheHitRatio != null) {
      conditions.push(
        `CAST(COALESCE(${prefix}.total_cache_read_tokens, 0) AS REAL) / CASE WHEN ${prefix}.total_tokens = 0 THEN 1 ELSE ${prefix}.total_tokens END >= ?`
      )
      params.push(filters.minCacheHitRatio)
    }

    if (filters.maxCacheHitRatio != null) {
      conditions.push(
        `CAST(COALESCE(${prefix}.total_cache_read_tokens, 0) AS REAL) / CASE WHEN ${prefix}.total_tokens = 0 THEN 1 ELSE ${prefix}.total_tokens END <= ?`
      )
      params.push(filters.maxCacheHitRatio)
    }

    if (filters.modelFilter) {
      conditions.push(
        `EXISTS (SELECT 1 FROM json_each(${prefix}.models_used) WHERE value = ?)`
      )
      params.push(filters.modelFilter)
    }

    return { conditions, params }
  }

  whereClause(filter: SqlFilter): string {
    if (filter.conditions.length === 0) return ''
    return 'WHERE ' + filter.conditions.join(' AND ')
  }

  costBreakdown(
    detail: ContextAuditDetail,
    options: CostBreakdownOptions
  ): CostBreakdownSummary | CostBreakdownFull {
    if (detail === 'full') {
      return this.costBreakdownFull(options)
    }
    return this.costBreakdownSummary(options)
  }

  private costBreakdownSummary(options: CostBreakdownOptions): CostBreakdownSummary {
    const filter = this.buildSessionFilters(options.filters)
    const where = filter.conditions.length > 0
      ? 'WHERE ' + filter.conditions.join(' AND ')
      : ''

    const aggRow = this.db.prepare(`
      SELECT
        COALESCE(SUM(s.cost_usd), 0) AS total_cost,
        COALESCE(AVG(s.cost_usd), 0) AS avg_cost,
        COUNT(*) AS session_count
      FROM sessions s
      ${where}
    `).get(...filter.params) as {
      total_cost: number
      avg_cost: number
      session_count: number
    }

    const { minCostSession, maxCostSession } = this.getMinMaxCostSessions(filter)

    const periods = options.groupBy
      ? this.getCostPeriods(options.groupBy, filter)
      : undefined

    return {
      totalCost: aggRow.total_cost,
      avgCost: aggRow.avg_cost,
      sessionCount: aggRow.session_count,
      minCostSession,
      maxCostSession,
      periods,
    }
  }

  private costBreakdownFull(options: CostBreakdownOptions): CostBreakdownFull {
    const filter = this.buildSessionFilters(options.filters)
    const where = filter.conditions.length > 0
      ? 'WHERE ' + filter.conditions.join(' AND ')
      : ''
    const limit = options.limit ?? 100

    const rows = this.db.prepare(`
      SELECT
        s.id,
        s.topic,
        s.started_at,
        s.cost_usd,
        s.total_tokens,
        COALESCE(s.total_cache_creation_tokens, 0) AS cache_creation,
        COALESCE(s.total_cache_read_tokens, 0) AS cache_read
      FROM sessions s
      ${where}
      ORDER BY s.cost_usd IS NULL, s.cost_usd DESC
      LIMIT ?
    `).all(...filter.params, limit) as Array<{
      id: string
      topic: string | null
      started_at: string | null
      cost_usd: number | null
      total_tokens: number
      cache_creation: number
      cache_read: number
    }>

    const sessions: CostSessionDetail[] = rows.map(row => ({
      id: row.id,
      topic: row.topic,
      startedAt: row.started_at,
      costUsd: row.cost_usd,
      totalTokens: row.total_tokens,
      cacheTokens: {
        creation: row.cache_creation,
        read: row.cache_read,
      },
    }))

    return { sessions }
  }

  private getMinMaxCostSessions(filter: SqlFilter): {
    minCostSession: SessionRef | null
    maxCostSession: SessionRef | null
  } {
    const where = filter.conditions.length > 0
      ? 'WHERE ' + filter.conditions.join(' AND ') + ' AND s.cost_usd IS NOT NULL'
      : 'WHERE s.cost_usd IS NOT NULL'

    const minRow = this.db.prepare(`
      SELECT s.id, s.topic, s.cost_usd
      FROM sessions s
      ${where}
      ORDER BY s.cost_usd ASC
      LIMIT 1
    `).get(...filter.params) as { id: string; topic: string | null; cost_usd: number } | undefined

    const maxRow = this.db.prepare(`
      SELECT s.id, s.topic, s.cost_usd
      FROM sessions s
      ${where}
      ORDER BY s.cost_usd DESC
      LIMIT 1
    `).get(...filter.params) as { id: string; topic: string | null; cost_usd: number } | undefined

    return {
      minCostSession: minRow
        ? { id: minRow.id, topic: minRow.topic, costUsd: minRow.cost_usd }
        : null,
      maxCostSession: maxRow
        ? { id: maxRow.id, topic: maxRow.topic, costUsd: maxRow.cost_usd }
        : null,
    }
  }

  private getCostPeriods(groupBy: TemporalGrouping, filter: SqlFilter): CostPeriod[] {
    const fmt = STRFTIME_FORMATS[groupBy]
    const where = filter.conditions.length > 0
      ? 'WHERE ' + filter.conditions.join(' AND ')
      : ''

    const rows = this.db.prepare(`
      SELECT
        strftime('${fmt}', s.started_at) AS period,
        COALESCE(SUM(s.cost_usd), 0) AS total_cost,
        COALESCE(AVG(s.cost_usd), 0) AS avg_cost,
        COUNT(*) AS session_count
      FROM sessions s
      ${where}
      GROUP BY period
      ORDER BY period
    `).all(...filter.params) as Array<{
      period: string
      total_cost: number
      avg_cost: number
      session_count: number
    }>

    return rows.map(row => ({
      period: row.period,
      totalCost: row.total_cost,
      avgCost: row.avg_cost,
      sessionCount: row.session_count,
    }))
  }
}
