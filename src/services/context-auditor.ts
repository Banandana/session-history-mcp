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
  TokenAttributionSummary,
  TokenAttributionFull,
  ContextUtilizationSummary,
  ContextUtilizationFull,
  CacheAnalysisSummary,
  CacheAnalysisFull,
  CollapseAnalysisSummary,
  CollapseAnalysisFull,
  SessionProfileSummary,
  SessionProfileFull,
  SessionProfileDetail,
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

  tokenAttribution(
    detail: ContextAuditDetail,
    options: { filters?: ContextAuditFilters; limit?: number }
  ): TokenAttributionSummary | TokenAttributionFull {
    if (detail === 'full') {
      return this.tokenAttributionFull(options)
    }
    return this.tokenAttributionSummary(options)
  }

  private tokenAttributionSummary(options: { filters?: ContextAuditFilters; limit?: number }): TokenAttributionSummary {
    const filter = this.buildSessionFilters(options.filters)
    const limit = options.limit ?? 100

    const msgConditions = [...filter.conditions, 'm.tool_names IS NOT NULL', "m.role = 'user'"]
    const where = 'WHERE ' + msgConditions.join(' AND ')

    const rows = this.db.prepare(`
      SELECT
        tool_name.value AS tool_name,
        SUM(m.token_count) AS total_tokens,
        COUNT(*) AS message_count
      FROM messages m
      JOIN sessions s ON s.id = m.session_id
      , json_each(m.tool_names) AS tool_name
      ${where}
      GROUP BY tool_name.value
      ORDER BY total_tokens DESC
      LIMIT ?
    `).all(...filter.params, limit) as Array<{
      tool_name: string
      total_tokens: number
      message_count: number
    }>

    const grandTotalRow = this.db.prepare(`
      SELECT COALESCE(SUM(m.token_count), 0) AS grand_total
      FROM messages m
      JOIN sessions s ON s.id = m.session_id
      ${where}
    `).get(...filter.params) as { grand_total: number }

    const grandTotal = grandTotalRow.grand_total

    const tools = rows.map(r => ({
      toolName: r.tool_name,
      totalTokens: r.total_tokens,
      messageCount: r.message_count,
      pctOfTotal: grandTotal > 0 ? Math.round(r.total_tokens / grandTotal * 1000) / 10 : 0,
    }))

    return { tools, totalToolResultTokens: grandTotal }
  }

  private tokenAttributionFull(options: { filters?: ContextAuditFilters; limit?: number }): TokenAttributionFull {
    const filter = this.buildSessionFilters(options.filters)
    const where = filter.conditions.length > 0
      ? 'WHERE ' + filter.conditions.join(' AND ')
      : ''
    const limit = options.limit ?? 100

    const sessionRows = this.db.prepare(`
      SELECT s.id, s.topic
      FROM sessions s
      ${where}
      ORDER BY s.total_tokens DESC
      LIMIT ?
    `).all(...filter.params, limit) as Array<{ id: string; topic: string | null }>

    if (sessionRows.length === 0) {
      return { sessions: [] }
    }

    const sessionIds = sessionRows.map(r => r.id)
    const placeholders = sessionIds.map(() => '?').join(',')

    const toolRows = this.db.prepare(`
      SELECT
        m.session_id,
        tool_name.value AS tool_name,
        m.role,
        SUM(m.token_count) AS total_tokens
      FROM messages m
      , json_each(m.tool_names) AS tool_name
      WHERE m.session_id IN (${placeholders})
        AND m.tool_names IS NOT NULL
      GROUP BY m.session_id, tool_name.value, m.role
    `).all(...sessionIds) as Array<{
      session_id: string
      tool_name: string
      role: string
      total_tokens: number
    }>

    const sessionToolMap = new Map<string, Map<string, { resultTokens: number; callTokens: number }>>()

    for (const row of toolRows) {
      if (!sessionToolMap.has(row.session_id)) {
        sessionToolMap.set(row.session_id, new Map())
      }
      const toolMap = sessionToolMap.get(row.session_id)!
      if (!toolMap.has(row.tool_name)) {
        toolMap.set(row.tool_name, { resultTokens: 0, callTokens: 0 })
      }
      const entry = toolMap.get(row.tool_name)!
      if (row.role === 'user') {
        entry.resultTokens += row.total_tokens
      } else {
        entry.callTokens += row.total_tokens
      }
    }

    const sessions = sessionRows.map(s => {
      const toolMap = sessionToolMap.get(s.id) ?? new Map()
      const tools = [...toolMap.entries()]
        .map(([toolName, { resultTokens, callTokens }]) => ({ toolName, resultTokens, callTokens }))
        .sort((a, b) => b.resultTokens - a.resultTokens)

      return {
        sessionId: s.id,
        topic: s.topic,
        tools,
      }
    })

    return { sessions }
  }

  contextUtilization(
    detail: ContextAuditDetail,
    options: { filters?: ContextAuditFilters; groupBy?: TemporalGrouping; limit?: number }
  ): ContextUtilizationSummary | ContextUtilizationFull {
    const limit = options.limit ?? 20
    const filter = this.buildSessionFilters(options.filters)
    const where = this.whereClause(filter)
    if (detail === 'full') return this.contextUtilizationFull(where, filter.params, limit)
    return this.contextUtilizationSummary(where, filter.params, options.groupBy)
  }

  private contextUtilizationSummary(
    where: string,
    params: (string | number)[],
    groupBy?: TemporalGrouping
  ): ContextUtilizationSummary {
    const aggRow = this.db.prepare(`
      SELECT AVG(s.total_tokens) as avg_total, MAX(s.total_tokens) as max_total,
             COUNT(*) as session_count,
             SUM(CASE WHEN cc.cnt > 0 THEN 1 ELSE 0 END) as sessions_with_collapses
      FROM sessions s
      LEFT JOIN (SELECT session_id, COUNT(*) as cnt FROM context_collapses GROUP BY session_id) cc
        ON cc.session_id = s.id
      ${where}
    `).get(...params) as {
      avg_total: number
      max_total: number
      session_count: number
      sessions_with_collapses: number
    }

    const allTokens = this.db.prepare(
      `SELECT total_tokens FROM sessions s ${where} ORDER BY total_tokens`
    ).all(...params) as Array<{ total_tokens: number }>
    const median = allTokens.length > 0
      ? allTokens[Math.floor(allTokens.length / 2)].total_tokens
      : 0

    const peakAvg = this.db.prepare(`
      SELECT AVG(peak) as avg_peak FROM (
        SELECT MAX(m.token_count) as peak FROM messages m
        JOIN sessions s ON m.session_id = s.id ${where}
        GROUP BY m.session_id
      )
    `).get(...params) as { avg_peak: number | null }

    const periods = groupBy
      ? this.getContextUtilizationPeriods(groupBy, where, params)
      : undefined

    return {
      avgTotalTokens: aggRow.avg_total ?? 0,
      medianTotalTokens: median,
      maxTotalTokens: aggRow.max_total ?? 0,
      avgPeakMessageTokens: peakAvg.avg_peak ?? 0,
      sessionsWithCollapses: {
        count: aggRow.sessions_with_collapses,
        percentage: aggRow.session_count > 0
          ? Math.round(aggRow.sessions_with_collapses / aggRow.session_count * 10000) / 100
          : 0,
      },
      periods,
    }
  }

  private contextUtilizationFull(
    where: string,
    params: (string | number)[],
    limit: number
  ): ContextUtilizationFull {
    const rows = this.db.prepare(`
      SELECT s.id, s.topic, s.total_tokens, s.total_turns,
             (SELECT MAX(m.token_count) FROM messages m WHERE m.session_id = s.id) as peak_msg,
             (SELECT COUNT(*) FROM context_collapses cc WHERE cc.session_id = s.id) as collapse_count
      FROM sessions s ${where}
      ORDER BY s.total_tokens DESC LIMIT ?
    `).all(...params, limit) as Array<{
      id: string
      topic: string | null
      total_tokens: number
      total_turns: number
      peak_msg: number | null
      collapse_count: number
    }>

    return {
      sessions: rows.map(r => ({
        id: r.id,
        topic: r.topic,
        totalTokens: r.total_tokens,
        peakMessageTokens: r.peak_msg ?? 0,
        collapseCount: r.collapse_count,
        totalTurns: r.total_turns,
      })),
    }
  }

  private getContextUtilizationPeriods(
    groupBy: TemporalGrouping,
    where: string,
    params: (string | number)[]
  ): ContextUtilizationSummary['periods'] {
    const fmt = STRFTIME_FORMATS[groupBy]
    const rows = this.db.prepare(`
      SELECT
        strftime('${fmt}', s.started_at) AS period,
        AVG(s.total_tokens) AS avg_total_tokens,
        COUNT(*) AS session_count,
        CAST(SUM(CASE WHEN cc.cnt > 0 THEN 1 ELSE 0 END) AS REAL) / MAX(COUNT(*), 1) * 100 AS collapse_rate
      FROM sessions s
      LEFT JOIN (SELECT session_id, COUNT(*) as cnt FROM context_collapses GROUP BY session_id) cc
        ON cc.session_id = s.id
      ${where}
      GROUP BY period
      ORDER BY period
    `).all(...params) as Array<{
      period: string
      avg_total_tokens: number
      session_count: number
      collapse_rate: number
    }>

    return rows.map(r => ({
      period: r.period,
      avgTotalTokens: r.avg_total_tokens,
      sessionCount: r.session_count,
      collapseRate: r.collapse_rate,
    }))
  }

  cacheAnalysis(
    detail: ContextAuditDetail,
    options: { filters?: ContextAuditFilters; groupBy?: TemporalGrouping; limit?: number }
  ): CacheAnalysisSummary | CacheAnalysisFull {
    const limit = options.limit ?? 20
    const filter = this.buildSessionFilters(options.filters)
    const where = this.whereClause(filter)
    if (detail === 'full') return this.cacheAnalysisFull(where, filter.params, limit)
    return this.cacheAnalysisSummary(where, filter.params, options.groupBy)
  }

  private cacheAnalysisSummary(
    where: string,
    params: (string | number)[],
    groupBy?: TemporalGrouping
  ): CacheAnalysisSummary {
    const aggRow = this.db.prepare(`
      SELECT
        CAST(SUM(COALESCE(s.total_cache_read_tokens, 0)) AS REAL) * 100.0 /
          CASE WHEN SUM(s.total_tokens) = 0 THEN 1 ELSE SUM(s.total_tokens) END AS overall_hit_ratio,
        AVG(
          CAST(COALESCE(s.total_cache_read_tokens, 0) AS REAL) * 100.0 /
            CASE WHEN s.total_tokens = 0 THEN 1 ELSE s.total_tokens END
        ) AS avg_hit_ratio,
        COALESCE(SUM(s.total_cache_creation_tokens), 0) AS total_cache_creation,
        COALESCE(SUM(s.total_cache_read_tokens), 0) AS total_cache_read,
        COUNT(*) AS session_count
      FROM sessions s
      ${where}
    `).get(...params) as {
      overall_hit_ratio: number
      avg_hit_ratio: number
      total_cache_creation: number
      total_cache_read: number
      session_count: number
    }

    const periods = groupBy
      ? this.getCacheAnalysisPeriods(groupBy, where, params)
      : undefined

    return {
      overallHitRatio: aggRow.overall_hit_ratio ?? 0,
      avgHitRatio: aggRow.avg_hit_ratio ?? 0,
      totalCacheCreation: aggRow.total_cache_creation,
      totalCacheRead: aggRow.total_cache_read,
      sessionCount: aggRow.session_count,
      periods,
    }
  }

  private cacheAnalysisFull(
    where: string,
    params: (string | number)[],
    limit: number
  ): CacheAnalysisFull {
    const rows = this.db.prepare(`
      SELECT
        s.id, s.topic, s.total_tokens,
        COALESCE(s.total_cache_creation_tokens, 0) AS cache_creation,
        COALESCE(s.total_cache_read_tokens, 0) AS cache_read,
        CAST(COALESCE(s.total_cache_read_tokens, 0) AS REAL) * 100.0 /
          CASE WHEN s.total_tokens = 0 THEN 1 ELSE s.total_tokens END AS hit_ratio
      FROM sessions s
      ${where}
      ORDER BY hit_ratio ASC
      LIMIT ?
    `).all(...params, limit) as Array<{
      id: string
      topic: string | null
      total_tokens: number
      cache_creation: number
      cache_read: number
      hit_ratio: number
    }>

    return {
      sessions: rows.map(r => ({
        id: r.id,
        topic: r.topic,
        cacheHitRatio: Math.round(r.hit_ratio * 10) / 10,
        cacheCreationTokens: r.cache_creation,
        cacheReadTokens: r.cache_read,
        totalTokens: r.total_tokens,
      })),
    }
  }

  private getCacheAnalysisPeriods(
    groupBy: TemporalGrouping,
    where: string,
    params: (string | number)[]
  ): CacheAnalysisSummary['periods'] {
    const fmt = STRFTIME_FORMATS[groupBy]
    const rows = this.db.prepare(`
      SELECT
        strftime('${fmt}', s.started_at) AS period,
        CAST(SUM(COALESCE(s.total_cache_read_tokens, 0)) AS REAL) * 100.0 /
          CASE WHEN SUM(s.total_tokens) = 0 THEN 1 ELSE SUM(s.total_tokens) END AS overall_hit_ratio,
        AVG(
          CAST(COALESCE(s.total_cache_read_tokens, 0) AS REAL) * 100.0 /
            CASE WHEN s.total_tokens = 0 THEN 1 ELSE s.total_tokens END
        ) AS avg_hit_ratio,
        COALESCE(SUM(s.total_cache_creation_tokens), 0) AS total_cache_creation,
        COALESCE(SUM(s.total_cache_read_tokens), 0) AS total_cache_read
      FROM sessions s
      ${where}
      GROUP BY period
      ORDER BY period
    `).all(...params) as Array<{
      period: string
      overall_hit_ratio: number
      avg_hit_ratio: number
      total_cache_creation: number
      total_cache_read: number
    }>

    return rows.map(r => ({
      period: r.period,
      overallHitRatio: r.overall_hit_ratio,
      avgHitRatio: r.avg_hit_ratio,
      totalCacheCreation: r.total_cache_creation,
      totalCacheRead: r.total_cache_read,
    }))
  }

  collapseAnalysis(
    detail: ContextAuditDetail,
    options: { filters?: ContextAuditFilters; groupBy?: TemporalGrouping; limit?: number }
  ): CollapseAnalysisSummary | CollapseAnalysisFull {
    const limit = options.limit ?? 20
    const filter = this.buildSessionFilters(options.filters)
    const where = this.whereClause(filter)
    if (detail === 'full') return this.collapseAnalysisFull(where, filter.params, limit)
    return this.collapseAnalysisSummary(where, filter.params, options.groupBy)
  }

  private collapseAnalysisSummary(
    where: string,
    params: (string | number)[],
    groupBy?: TemporalGrouping
  ): CollapseAnalysisSummary {
    const aggRow = this.db.prepare(`
      SELECT
        COALESCE(SUM(cc.cnt), 0) AS total_collapses,
        SUM(CASE WHEN cc.cnt > 0 THEN 1 ELSE 0 END) AS sessions_with_collapses,
        COUNT(*) AS total_sessions
      FROM sessions s
      LEFT JOIN (SELECT session_id, COUNT(*) as cnt FROM context_collapses GROUP BY session_id) cc
        ON cc.session_id = s.id
      ${where}
    `).get(...params) as {
      total_collapses: number
      sessions_with_collapses: number
      total_sessions: number
    }

    const maxRow = this.db.prepare(`
      SELECT s.id, s.topic, COUNT(*) as collapse_count
      FROM context_collapses cc
      JOIN sessions s ON s.id = cc.session_id
      ${where ? where + ' AND 1=1' : ''}
      GROUP BY cc.session_id
      ORDER BY collapse_count DESC
      LIMIT 1
    `).get(...params) as { id: string; topic: string | null; collapse_count: number } | undefined

    const periods = groupBy
      ? this.getCollapseAnalysisPeriods(groupBy, where, params)
      : undefined

    return {
      totalCollapses: aggRow.total_collapses,
      avgCollapsesPerSession: aggRow.total_sessions > 0
        ? aggRow.total_collapses / aggRow.total_sessions
        : 0,
      sessionsWithCollapses: {
        count: aggRow.sessions_with_collapses,
        percentage: aggRow.total_sessions > 0
          ? Math.round(aggRow.sessions_with_collapses / aggRow.total_sessions * 10000) / 100
          : 0,
      },
      maxCollapseSession: maxRow
        ? { id: maxRow.id, topic: maxRow.topic, costUsd: null, collapseCount: maxRow.collapse_count }
        : null,
      periods,
    }
  }

  private collapseAnalysisFull(
    where: string,
    params: (string | number)[],
    limit: number
  ): CollapseAnalysisFull {
    const sessionRows = this.db.prepare(`
      SELECT s.id, s.topic, s.total_tokens, COUNT(cc.collapse_id) as collapse_count
      FROM sessions s
      JOIN context_collapses cc ON cc.session_id = s.id
      ${where}
      GROUP BY s.id
      ORDER BY collapse_count DESC
      LIMIT ?
    `).all(...params, limit) as Array<{
      id: string
      topic: string | null
      total_tokens: number
      collapse_count: number
    }>

    if (sessionRows.length === 0) return { sessions: [] }

    const sessionIds = sessionRows.map(r => r.id)
    const placeholders = sessionIds.map(() => '?').join(',')

    const collapseRows = this.db.prepare(`
      SELECT session_id, collapse_id, summary
      FROM context_collapses
      WHERE session_id IN (${placeholders})
      ORDER BY rowid
    `).all(...sessionIds) as Array<{
      session_id: string
      collapse_id: string
      summary: string | null
    }>

    const collapseMap = new Map<string, Array<{ collapseId: string; summary: string | null }>>()
    for (const row of collapseRows) {
      if (!collapseMap.has(row.session_id)) {
        collapseMap.set(row.session_id, [])
      }
      collapseMap.get(row.session_id)!.push({
        collapseId: row.collapse_id,
        summary: row.summary,
      })
    }

    return {
      sessions: sessionRows.map(r => ({
        id: r.id,
        topic: r.topic,
        totalTokens: r.total_tokens,
        collapses: collapseMap.get(r.id) ?? [],
      })),
    }
  }

  private getCollapseAnalysisPeriods(
    groupBy: TemporalGrouping,
    where: string,
    params: (string | number)[]
  ): CollapseAnalysisSummary['periods'] {
    const fmt = STRFTIME_FORMATS[groupBy]
    const rows = this.db.prepare(`
      SELECT
        strftime('${fmt}', s.started_at) AS period,
        COALESCE(SUM(cc.cnt), 0) AS total_collapses,
        COUNT(*) AS session_count,
        CAST(COALESCE(SUM(cc.cnt), 0) AS REAL) / MAX(COUNT(*), 1) AS avg_per_session
      FROM sessions s
      LEFT JOIN (SELECT session_id, COUNT(*) as cnt FROM context_collapses GROUP BY session_id) cc
        ON cc.session_id = s.id
      ${where}
      GROUP BY period
      ORDER BY period
    `).all(...params) as Array<{
      period: string
      total_collapses: number
      session_count: number
      avg_per_session: number
    }>

    return rows.map(r => ({
      period: r.period,
      totalCollapses: r.total_collapses,
      sessionCount: r.session_count,
      avgPerSession: r.avg_per_session,
    }))
  }

  sessionProfile(
    detail: ContextAuditDetail,
    options: { filters?: ContextAuditFilters; limit?: number }
  ): SessionProfileSummary | SessionProfileFull {
    const filter = this.buildSessionFilters(options.filters)
    const where = this.whereClause(filter)
    if (detail === 'full') return this.sessionProfileFull(where, filter.params, options.limit ?? 100)
    return this.sessionProfileSummary(where, filter.params)
  }

  private sessionProfileSummary(
    where: string,
    params: (string | number)[]
  ): SessionProfileSummary {
    const aggRow = this.db.prepare(`
      SELECT
        COALESCE(SUM(s.cost_usd), 0) AS total_cost,
        COALESCE(SUM(s.total_tokens), 0) AS total_tokens,
        COUNT(*) AS session_count,
        AVG(
          CAST(COALESCE(s.total_cache_read_tokens, 0) AS REAL) * 100.0 /
            CASE WHEN s.total_tokens = 0 THEN 1 ELSE s.total_tokens END
        ) AS avg_cache_hit_ratio
      FROM sessions s
      ${where}
    `).get(...params) as {
      total_cost: number
      total_tokens: number
      session_count: number
      avg_cache_hit_ratio: number
    }

    const collapseRow = this.db.prepare(`
      SELECT COALESCE(SUM(cc.cnt), 0) AS total_collapses
      FROM sessions s
      LEFT JOIN (SELECT session_id, COUNT(*) as cnt FROM context_collapses GROUP BY session_id) cc
        ON cc.session_id = s.id
      ${where}
    `).get(...params) as { total_collapses: number }

    const topExpensive = this.db.prepare(`
      SELECT s.id, s.topic, s.cost_usd
      FROM sessions s
      ${where ? where + ' AND s.cost_usd IS NOT NULL' : 'WHERE s.cost_usd IS NOT NULL'}
      ORDER BY s.cost_usd DESC
      LIMIT 3
    `).all(...params) as Array<{ id: string; topic: string | null; cost_usd: number }>

    const topTokenHeavy = this.db.prepare(`
      SELECT s.id, s.topic, s.cost_usd, s.total_tokens
      FROM sessions s
      ${where}
      ORDER BY s.total_tokens DESC
      LIMIT 3
    `).all(...params) as Array<{ id: string; topic: string | null; cost_usd: number | null; total_tokens: number }>

    const topWorstCache = this.db.prepare(`
      SELECT s.id, s.topic, s.cost_usd,
        CAST(COALESCE(s.total_cache_read_tokens, 0) AS REAL) * 100.0 /
          CASE WHEN s.total_tokens = 0 THEN 1 ELSE s.total_tokens END AS cache_hit_ratio
      FROM sessions s
      ${where ? where + ' AND s.total_tokens > 0' : 'WHERE s.total_tokens > 0'}
      ORDER BY cache_hit_ratio ASC
      LIMIT 3
    `).all(...params) as Array<{ id: string; topic: string | null; cost_usd: number | null; cache_hit_ratio: number }>

    return {
      totalCost: aggRow.total_cost,
      totalTokens: aggRow.total_tokens,
      avgCacheHitRatio: aggRow.avg_cache_hit_ratio ?? 0,
      totalCollapses: collapseRow.total_collapses,
      sessionCount: aggRow.session_count,
      topExpensive: topExpensive.map(r => ({ id: r.id, topic: r.topic, costUsd: r.cost_usd })),
      topTokenHeavy: topTokenHeavy.map(r => ({ id: r.id, topic: r.topic, costUsd: r.cost_usd, totalTokens: r.total_tokens })),
      topWorstCache: topWorstCache.map(r => ({ id: r.id, topic: r.topic, costUsd: r.cost_usd, cacheHitRatio: Math.round(r.cache_hit_ratio * 10) / 10 })),
    }
  }

  private sessionProfileFull(
    where: string,
    params: (string | number)[],
    limit: number
  ): SessionProfileFull {
    const rows = this.db.prepare(`
      SELECT
        s.id, s.topic, s.started_at, s.cost_usd, s.total_tokens, s.total_turns,
        s.models_used,
        COALESCE(s.total_cache_creation_tokens, 0) AS cache_creation,
        COALESCE(s.total_cache_read_tokens, 0) AS cache_read,
        CAST(COALESCE(s.total_cache_read_tokens, 0) AS REAL) * 100.0 /
          CASE WHEN s.total_tokens = 0 THEN 1 ELSE s.total_tokens END AS hit_ratio,
        (SELECT MAX(m.token_count) FROM messages m WHERE m.session_id = s.id) AS peak_msg,
        (SELECT COUNT(*) FROM context_collapses cc WHERE cc.session_id = s.id) AS collapse_count,
        CASE
          WHEN s.started_at IS NOT NULL AND (SELECT MAX(m.timestamp) FROM messages m WHERE m.session_id = s.id) IS NOT NULL
          THEN ROUND((julianday((SELECT MAX(m.timestamp) FROM messages m WHERE m.session_id = s.id)) - julianday(s.started_at)) * 1440, 1)
          ELSE NULL
        END AS duration_minutes
      FROM sessions s
      ${where}
      ORDER BY s.total_tokens DESC
      LIMIT ?
    `).all(...params, limit) as Array<{
      id: string
      topic: string | null
      started_at: string | null
      cost_usd: number | null
      total_tokens: number
      total_turns: number
      models_used: string | null
      cache_creation: number
      cache_read: number
      hit_ratio: number
      peak_msg: number | null
      collapse_count: number
      duration_minutes: number | null
    }>

    if (rows.length === 0) return { sessions: [] }

    // Batch topTools query
    const sessionIds = rows.map(r => r.id)
    const placeholders = sessionIds.map(() => '?').join(',')

    const toolRows = this.db.prepare(`
      SELECT m.session_id, tool_name.value as tool_name, SUM(m.token_count) as total_tokens
      FROM messages m, json_each(m.tool_names) as tool_name
      WHERE m.session_id IN (${placeholders})
        AND m.tool_names IS NOT NULL AND m.role = 'user'
      GROUP BY m.session_id, tool_name.value
      ORDER BY m.session_id, total_tokens DESC
    `).all(...sessionIds) as Array<{
      session_id: string
      tool_name: string
      total_tokens: number
    }>

    // Group tools by session, keep top 5 per session
    const toolsBySession = new Map<string, Array<{ toolName: string; tokenCount: number }>>()
    for (const row of toolRows) {
      if (!toolsBySession.has(row.session_id)) {
        toolsBySession.set(row.session_id, [])
      }
      const tools = toolsBySession.get(row.session_id)!
      if (tools.length < 5) {
        tools.push({ toolName: row.tool_name, tokenCount: row.total_tokens })
      }
    }

    const sessions: SessionProfileDetail[] = rows.map(r => {
      let modelsUsed: readonly string[] = []
      if (r.models_used) {
        try { modelsUsed = JSON.parse(r.models_used) } catch { /* ignore */ }
      }

      return {
        id: r.id,
        topic: r.topic,
        startedAt: r.started_at,
        durationMinutes: r.duration_minutes,
        costUsd: r.cost_usd,
        totalTokens: r.total_tokens,
        cacheTokens: {
          creation: r.cache_creation,
          read: r.cache_read,
          hitRatio: Math.round(r.hit_ratio * 10) / 10,
        },
        collapseCount: r.collapse_count,
        totalTurns: r.total_turns,
        peakMessageTokens: r.peak_msg ?? 0,
        topTools: toolsBySession.get(r.id) ?? [],
        modelsUsed,
      }
    })

    return { sessions }
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
