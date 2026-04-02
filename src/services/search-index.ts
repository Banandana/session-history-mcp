import type Database from 'better-sqlite3'
import type { DateRange } from '../types'

export interface SearchResult {
  readonly messageId: string
  readonly sessionId: string
  readonly projectSlug: string
  readonly timestamp: string
  readonly contentPreview: string
  readonly matchSnippet: string
  readonly rank: number
}

export interface SearchOptions {
  readonly projectSlug?: string
  readonly sessionId?: string
  readonly dateRange?: DateRange
  readonly limit?: number
  readonly offset?: number
}

export class SearchIndex {
  constructor(private readonly db: Database.Database) {}

  search(query: string, options?: SearchOptions): SearchResult[] {
    if (!query.trim()) return []

    const conditions: string[] = ['messages_fts.search_text MATCH ?']
    const params: unknown[] = [query]

    if (options?.projectSlug) {
      conditions.push('s.project_slug = ?')
      params.push(options.projectSlug)
    }

    if (options?.sessionId) {
      conditions.push('m.session_id = ?')
      params.push(options.sessionId)
    }

    if (options?.dateRange?.from) {
      conditions.push('m.timestamp >= ?')
      params.push(options.dateRange.from)
    }

    if (options?.dateRange?.to) {
      conditions.push('m.timestamp <= ?')
      params.push(options.dateRange.to)
    }

    const limit = options?.limit ?? 50
    const offset = options?.offset ?? 0

    const sql = `
      SELECT
        m.id AS messageId,
        m.session_id AS sessionId,
        COALESCE(s.project_slug, '') AS projectSlug,
        m.timestamp,
        m.content_preview AS contentPreview,
        snippet(messages_fts, 0, '»', '«', '…', 40) AS matchSnippet,
        rank
      FROM messages_fts
      JOIN messages m ON m.rowid = messages_fts.rowid
      LEFT JOIN sessions s ON s.id = m.session_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY rank
      LIMIT ? OFFSET ?
    `

    params.push(limit, offset)

    const rows = this.db.prepare(sql).all(...params) as Array<{
      messageId: string
      sessionId: string
      projectSlug: string
      timestamp: string
      contentPreview: string
      matchSnippet: string
      rank: number
    }>

    return rows.map(row => ({
      messageId: row.messageId,
      sessionId: row.sessionId,
      projectSlug: row.projectSlug ?? '',
      timestamp: row.timestamp ?? '',
      contentPreview: row.contentPreview ?? '',
      matchSnippet: row.matchSnippet ?? '',
      rank: row.rank,
    }))
  }

  searchCount(query: string, options?: { projectSlug?: string; sessionId?: string }): number {
    if (!query.trim()) return 0

    const conditions: string[] = ['messages_fts.search_text MATCH ?']
    const params: unknown[] = [query]

    if (options?.projectSlug) {
      conditions.push('s.project_slug = ?')
      params.push(options.projectSlug)
    }

    if (options?.sessionId) {
      conditions.push('m.session_id = ?')
      params.push(options.sessionId)
    }

    const sql = `
      SELECT COUNT(*) AS cnt
      FROM messages_fts
      JOIN messages m ON m.rowid = messages_fts.rowid
      LEFT JOIN sessions s ON s.id = m.session_id
      WHERE ${conditions.join(' AND ')}
    `

    const row = this.db.prepare(sql).get(...params) as { cnt: number }
    return row.cnt
  }
}
