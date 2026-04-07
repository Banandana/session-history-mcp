import { container } from 'tsyringe'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { TOKENS } from '../container/tokens'
import type { FreshnessGuard } from '../services/freshness-guard'
import type { ProjectResolver } from '../services/project-resolver'
import type { PaginationManager } from '../services/pagination-manager'
import type { ResponseFormatter } from '../services/response-formatter'
import type { DatabaseConnection } from '../infrastructure/database'

const SORT_COLUMNS: Record<string, string> = {
  recent: 'started_at DESC',
  longest: 'duration_minutes DESC',
  most_turns: 'total_turns DESC',
  most_tokens: 'total_tokens DESC',
  errors: 'error_count DESC',
  cost: 'cost_usd IS NULL, cost_usd DESC',
  cache_efficiency: 'CAST(COALESCE(total_cache_read_tokens, 0) AS REAL) / CASE WHEN total_tokens = 0 THEN 1 ELSE total_tokens END ASC',
}

export function registerListSessions(server: McpServer): void {
  server.tool(
    'list_sessions',
    'List sessions with rich metadata — topic, summary, duration, errors. Supports filtering, sorting, and pagination.',
    {
      project: z.string().optional().describe('Project slug'),
      path: z.string().optional().describe('Filesystem path to project or subdirectory'),
      branch: z.string().optional().describe('Filter by git branch'),
      from: z.string().optional().describe('Start date ISO 8601'),
      to: z.string().optional().describe('End date ISO 8601'),
      sortBy: z.enum(['recent', 'longest', 'most_turns', 'most_tokens', 'errors', 'cost', 'cache_efficiency']).optional().describe('Sort order (default: recent)'),
      resolution: z.enum(['low', 'medium']).optional().describe('Response density: low (scanning) or medium (default, full card)'),
      limit: z.number().int().min(1).max(1000).optional().describe('Maximum number of sessions to return'),
      minTokens: z.number().optional().describe('Minimum total tokens'),
      maxTokens: z.number().optional().describe('Maximum total tokens'),
      minCost: z.number().optional().describe('Minimum cost in USD'),
      maxCost: z.number().optional().describe('Maximum cost in USD'),
      minCacheHitRatio: z.number().min(0).max(100).optional().describe('Minimum cache hit ratio (0-100)'),
      maxCacheHitRatio: z.number().min(0).max(100).optional().describe('Maximum cache hit ratio (0-100)'),
      cursor: z.string().optional().describe('Pagination cursor'),
    },
    async (params) => {
      const freshnessGuard = container.resolve<FreshnessGuard>(TOKENS.FreshnessGuard)
      const projectResolver = container.resolve<ProjectResolver>(TOKENS.ProjectResolver)
      const pagination = container.resolve<PaginationManager>(TOKENS.PaginationManager)
      const formatter = container.resolve<ResponseFormatter>(TOKENS.ResponseFormatter)
      const dbConn = container.resolve<DatabaseConnection>(TOKENS.Database)
      const db = dbConn.get()

      const freshness = await freshnessGuard.ensureFresh()

      const slug = await projectResolver.resolveProjectFilter({
        project: params.project,
        path: params.path,
      })

      // Build SQL query
      const conditions: string[] = []
      const sqlParams: (string | number)[] = []

      if (slug) {
        conditions.push('project_slug = ?')
        sqlParams.push(slug)
      }
      if (params.branch) {
        conditions.push('branch = ?')
        sqlParams.push(params.branch)
      }
      if (params.from) {
        conditions.push('started_at >= ?')
        sqlParams.push(params.from)
      }
      if (params.to) {
        conditions.push('started_at <= ?')
        sqlParams.push(params.to)
      }
      if (params.minTokens != null) {
        conditions.push('total_tokens >= ?')
        sqlParams.push(params.minTokens)
      }
      if (params.maxTokens != null) {
        conditions.push('total_tokens <= ?')
        sqlParams.push(params.maxTokens)
      }
      if (params.minCost != null) {
        conditions.push('cost_usd >= ?')
        sqlParams.push(params.minCost)
      }
      if (params.maxCost != null) {
        conditions.push('cost_usd <= ?')
        sqlParams.push(params.maxCost)
      }
      if (params.minCacheHitRatio != null) {
        conditions.push('(CAST(COALESCE(total_cache_read_tokens, 0) AS REAL) / CASE WHEN total_tokens = 0 THEN 1 ELSE total_tokens END * 100) >= ?')
        sqlParams.push(params.minCacheHitRatio)
      }
      if (params.maxCacheHitRatio != null) {
        conditions.push('(CAST(COALESCE(total_cache_read_tokens, 0) AS REAL) / CASE WHEN total_tokens = 0 THEN 1 ELSE total_tokens END * 100) <= ?')
        sqlParams.push(params.maxCacheHitRatio)
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
      const orderBy = SORT_COLUMNS[params.sortBy ?? 'recent']

      const sql = `
        SELECT id, source, project_slug, cwd, branch, started_at, ended_at,
               duration_minutes, total_turns, total_tokens, message_count,
               error_count, topic, summary, custom_title, ai_title, tags,
               cost_usd, mode, entrypoint, models_used,
               total_cache_read_tokens, total_cache_creation_tokens,
               (SELECT COUNT(*) FROM context_collapses WHERE session_id = sessions.id) as collapse_count
        FROM sessions
        ${whereClause}
        ORDER BY ${orderBy}
      `

      const rows = db.prepare(sql).all(...sqlParams) as Array<Record<string, unknown>>

      const sessions = rows.map(row => {
        const title = (row.custom_title as string | null) ?? (row.ai_title as string | null)
        return {
          id: row.id as string,
          source: row.source as string,
          projectSlug: row.project_slug as string,
          cwd: row.cwd as string,
          branch: row.branch as string | null,
          startedAt: row.started_at as string,
          endedAt: row.ended_at as string | null,
          durationMinutes: row.duration_minutes as number | null,
          totalTurns: row.total_turns as number,
          totalTokens: row.total_tokens as number,
          messageCount: row.message_count as number | null,
          errorCount: row.error_count as number | null,
          topic: row.topic as string | null,
          summary: row.summary as string | null,
          title,
          costUsd: row.cost_usd as number | null,
          mode: row.mode as string | null,
          entrypoint: row.entrypoint as string | null,
          tags: row.tags ? JSON.parse(row.tags as string) as string[] : null,
          modelsUsed: row.models_used ? JSON.parse(row.models_used as string) as string[] : null,
          cacheTokens: {
            creation: (row.total_cache_creation_tokens as number | null) ?? 0,
            read: (row.total_cache_read_tokens as number | null) ?? 0,
            hitRatio: Math.round(
              ((row.total_cache_read_tokens as number ?? 0) /
                Math.max(row.total_tokens as number, 1)) * 1000
            ) / 10,
          },
          contextCollapseCount: row.collapse_count as number,
        }
      })

      const resolution = params.resolution ?? 'medium'
      const output = resolution === 'low'
        ? sessions.map(s => ({
            id: s.id,
            startedAt: s.startedAt,
            endedAt: s.endedAt,
            durationMinutes: s.durationMinutes,
            topic: s.topic,
          }))
        : sessions

      const page = pagination.paginate(output, {
        cursor: params.cursor,
        limit: params.limit,
      })

      const meta = formatter.formatMeta(freshness)
      const paginationResult = page.hasMore
        ? { cursor: page.cursor!, hasMore: true, totalEstimate: page.totalEstimate }
        : { cursor: '', hasMore: false, totalEstimate: page.totalEstimate }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(formatter.format(page.items, meta, paginationResult), null, 2) }],
      }
    }
  )
}
