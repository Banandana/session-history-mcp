import { container } from 'tsyringe'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { TOKENS } from '../container/tokens'
import type { FreshnessGuard } from '../services/freshness-guard'
import type { Analyzer } from '../services/analyzer'
import type { ProjectResolver } from '../services/project-resolver'
import type { ResponseFormatter } from '../services/response-formatter'

export function registerAnalyze(server: McpServer): void {
  server.tool(
    'analyze',
    'Aggregation and pattern discovery across sessions. Analyze errors, corrections, tool failures, costly sessions, or frequently changed files.',
    {
      metric: z.enum(['errors', 'corrections', 'tool_failures', 'costly_sessions', 'frequent_files', 'cache_efficiency', 'model_usage']).describe('What to analyze'),
      project: z.string().optional().describe('Filter by project slug'),
      path: z.string().optional().describe('Resolve project from filesystem path'),
      from: z.string().optional().describe('Start date ISO 8601'),
      to: z.string().optional().describe('End date ISO 8601'),
      limit: z.number().optional().describe('Maximum results to return'),
    },
    async (params) => {
      const freshnessGuard = container.resolve<FreshnessGuard>(TOKENS.FreshnessGuard)
      const analyzer = container.resolve<Analyzer>(TOKENS.Analyzer)
      const projectResolver = container.resolve<ProjectResolver>(TOKENS.ProjectResolver)
      const formatter = container.resolve<ResponseFormatter>(TOKENS.ResponseFormatter)

      const freshness = await freshnessGuard.ensureFresh()

      const projectSlug = await projectResolver.resolveProjectFilter({
        project: params.project,
        path: params.path,
      })

      const dateRange = (params.from || params.to)
        ? { from: params.from, to: params.to }
        : undefined

      const results = analyzer.analyze(params.metric, {
        projectSlug,
        dateRange,
        limit: params.limit,
      })

      const meta = formatter.formatMeta(freshness)
      const response = formatter.format(results, meta)

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      }
    }
  )
}
