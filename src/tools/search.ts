import { container } from 'tsyringe'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { TOKENS } from '../container/tokens'
import type { FreshnessGuard } from '../services/freshness-guard'
import type { SearchIndex } from '../services/search-index'
import type { ProjectResolver } from '../services/project-resolver'
import type { PaginationManager } from '../services/pagination-manager'
import type { ResponseFormatter } from '../services/response-formatter'

export function registerSearch(server: McpServer): void {
  server.tool(
    'search',
    'FTS5 full-text search across all session messages. Supports AND, OR, "exact phrase" queries with optional project, session, and date filters.',
    {
      query: z.string().describe('Search query (supports AND, OR, "exact phrase")'),
      project: z.string().optional().describe('Filter by project slug'),
      path: z.string().optional().describe('Resolve project from filesystem path'),
      from: z.string().optional().describe('Start date ISO 8601'),
      to: z.string().optional().describe('End date ISO 8601'),
      sessionId: z.string().optional().describe('Restrict to specific session'),
      maxResults: z.number().optional().describe('Maximum results to return'),
      cursor: z.string().optional().describe('Pagination cursor'),
    },
    async (params) => {
      const freshnessGuard = container.resolve<FreshnessGuard>(TOKENS.FreshnessGuard)
      const searchIndex = container.resolve<SearchIndex>(TOKENS.SearchIndex)
      const projectResolver = container.resolve<ProjectResolver>(TOKENS.ProjectResolver)
      const pagination = container.resolve<PaginationManager>(TOKENS.PaginationManager)
      const formatter = container.resolve<ResponseFormatter>(TOKENS.ResponseFormatter)

      const freshness = await freshnessGuard.ensureFresh()

      const projectSlug = await projectResolver.resolveProjectFilter({
        project: params.project,
        path: params.path,
      })

      const dateRange = (params.from || params.to)
        ? { from: params.from, to: params.to }
        : undefined

      // Pass offset + limit + 1 to SQL so pagination can detect hasMore,
      // but let the pagination layer handle actual slicing.
      const paginationOffset = params.cursor
        ? pagination.decodeCursor(params.cursor)
        : 0
      const limit = params.maxResults ?? 50
      const results = searchIndex.search(params.query, {
        projectSlug,
        sessionId: params.sessionId,
        dateRange,
        limit: paginationOffset + limit + 1,
      })

      const page = pagination.paginate(results, {
        cursor: params.cursor,
        limit,
      })

      const meta = formatter.formatMeta(freshness)
      const paginationResult = page.hasMore
        ? { cursor: page.cursor!, hasMore: true, totalEstimate: page.totalEstimate }
        : { cursor: '', hasMore: false, totalEstimate: page.totalEstimate }

      const response = formatter.format(page.items, meta, paginationResult)

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      }
    }
  )
}
