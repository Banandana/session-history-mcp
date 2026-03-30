import type Database from 'better-sqlite3'
import type { DateRange } from '../types'

function formatSessionLabel(startedAt: string | null, topic: string | null): string {
  const date = startedAt ? startedAt.slice(0, 10) : 'unknown'
  return topic ? `${date} — ${topic}` : date
}

export interface AnalysisResult {
  readonly label: string
  readonly count: number
  readonly sessionId?: string
  readonly projectSlug?: string
  readonly details?: string
}

type AnalyzeOptions = {
  projectSlug?: string
  dateRange?: DateRange
  limit?: number
}

export class Analyzer {
  constructor(private readonly db: Database.Database) {}

  analyze(
    metric: 'errors' | 'corrections' | 'tool_failures' | 'costly_sessions' | 'frequent_files',
    options?: AnalyzeOptions
  ): AnalysisResult[] {
    switch (metric) {
      case 'errors': return this.analyzeErrors(options)
      case 'corrections': return this.analyzeCorrections(options)
      case 'tool_failures': return this.analyzeToolFailures(options)
      case 'costly_sessions': return this.analyzeCostlySessions(options)
      case 'frequent_files': return this.analyzeFrequentFiles(options)
    }
  }

  private analyzeErrors(options?: AnalyzeOptions): AnalysisResult[] {
    const limit = options?.limit ?? 10
    const params: (string | number)[] = []

    let sql = `
      SELECT s.id, s.project_slug, s.started_at, s.topic, COUNT(*) as error_count
      FROM messages m
      JOIN sessions s ON m.session_id = s.id
      WHERE m.is_error = 1
    `

    if (options?.projectSlug) {
      sql += ` AND s.project_slug = ?`
      params.push(options.projectSlug)
    }

    if (options?.dateRange?.from) {
      sql += ` AND m.timestamp >= ?`
      params.push(options.dateRange.from)
    }

    if (options?.dateRange?.to) {
      sql += ` AND m.timestamp <= ?`
      params.push(options.dateRange.to)
    }

    sql += ` GROUP BY s.id ORDER BY error_count DESC LIMIT ?`
    params.push(limit)

    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: string
      project_slug: string | null
      started_at: string | null
      topic: string | null
      error_count: number
    }>

    return rows.map(row => ({
      label: formatSessionLabel(row.started_at, row.topic),
      count: row.error_count,
      sessionId: row.id,
      projectSlug: row.project_slug ?? undefined,
    }))
  }

  private analyzeCorrections(options?: AnalyzeOptions): AnalysisResult[] {
    const limit = options?.limit ?? 10
    const params: (string | number)[] = []

    let sql = `
      SELECT s.id, s.project_slug, s.started_at, s.topic, COUNT(*) as correction_count
      FROM messages m
      JOIN sessions s ON m.session_id = s.id
      WHERE m.is_correction = 1
    `

    if (options?.projectSlug) {
      sql += ` AND s.project_slug = ?`
      params.push(options.projectSlug)
    }

    if (options?.dateRange?.from) {
      sql += ` AND m.timestamp >= ?`
      params.push(options.dateRange.from)
    }

    if (options?.dateRange?.to) {
      sql += ` AND m.timestamp <= ?`
      params.push(options.dateRange.to)
    }

    sql += ` GROUP BY s.id ORDER BY correction_count DESC LIMIT ?`
    params.push(limit)

    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: string
      project_slug: string | null
      started_at: string | null
      topic: string | null
      correction_count: number
    }>

    return rows.map(row => ({
      label: formatSessionLabel(row.started_at, row.topic),
      count: row.correction_count,
      sessionId: row.id,
      projectSlug: row.project_slug ?? undefined,
    }))
  }

  private analyzeToolFailures(options?: AnalyzeOptions): AnalysisResult[] {
    const limit = options?.limit ?? 10
    const params: (string | number)[] = []

    let sql = `
      SELECT m.tool_names, COUNT(*) as failure_count
      FROM messages m
    `

    if (options?.projectSlug) {
      sql += ` JOIN sessions s ON m.session_id = s.id`
    }

    sql += ` WHERE m.is_error = 1 AND m.tool_names IS NOT NULL`

    if (options?.projectSlug) {
      sql += ` AND s.project_slug = ?`
      params.push(options.projectSlug)
    }

    if (options?.dateRange?.from) {
      sql += ` AND m.timestamp >= ?`
      params.push(options.dateRange.from)
    }

    if (options?.dateRange?.to) {
      sql += ` AND m.timestamp <= ?`
      params.push(options.dateRange.to)
    }

    sql += ` GROUP BY m.tool_names ORDER BY failure_count DESC LIMIT ?`
    params.push(limit)

    const rows = this.db.prepare(sql).all(...params) as Array<{
      tool_names: string
      failure_count: number
    }>

    return rows.map(row => ({
      label: row.tool_names,
      count: row.failure_count,
      details: row.tool_names,
    }))
  }

  private analyzeCostlySessions(options?: AnalyzeOptions): AnalysisResult[] {
    const limit = options?.limit ?? 10
    const params: (string | number)[] = []

    let sql = `
      SELECT id, project_slug, started_at, topic, total_tokens
      FROM sessions
      WHERE 1 = 1
    `

    if (options?.projectSlug) {
      sql += ` AND project_slug = ?`
      params.push(options.projectSlug)
    }

    if (options?.dateRange?.from) {
      sql += ` AND started_at >= ?`
      params.push(options.dateRange.from)
    }

    if (options?.dateRange?.to) {
      sql += ` AND started_at <= ?`
      params.push(options.dateRange.to)
    }

    sql += ` ORDER BY total_tokens DESC LIMIT ?`
    params.push(limit)

    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: string
      project_slug: string | null
      started_at: string | null
      topic: string | null
      total_tokens: number
    }>

    return rows.map(row => ({
      label: formatSessionLabel(row.started_at, row.topic),
      count: row.total_tokens,
      sessionId: row.id,
      projectSlug: row.project_slug ?? undefined,
    }))
  }

  private analyzeFrequentFiles(options?: AnalyzeOptions): AnalysisResult[] {
    const limit = options?.limit ?? 10
    const params: (string | number)[] = []

    let sql = `
      SELECT fc.file_path, COUNT(*) as change_count
      FROM file_changes fc
    `

    if (options?.projectSlug) {
      sql += ` JOIN sessions s ON fc.session_id = s.id`
    }

    sql += ` WHERE fc.file_path IS NOT NULL`

    if (options?.projectSlug) {
      sql += ` AND s.project_slug = ?`
      params.push(options.projectSlug)
    }

    if (options?.dateRange?.from) {
      sql += ` AND fc.timestamp >= ?`
      params.push(options.dateRange.from)
    }

    if (options?.dateRange?.to) {
      sql += ` AND fc.timestamp <= ?`
      params.push(options.dateRange.to)
    }

    sql += ` GROUP BY fc.file_path ORDER BY change_count DESC LIMIT ?`
    params.push(limit)

    const rows = this.db.prepare(sql).all(...params) as Array<{
      file_path: string
      change_count: number
    }>

    return rows.map(row => ({
      label: row.file_path,
      count: row.change_count,
      details: row.file_path,
    }))
  }
}
