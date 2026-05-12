import { container } from '../container'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { TOKENS } from '../container/tokens'
import type { AuditHistoryService } from '../services/audit-history'
import type { ResponseFormatter } from '../services/response-formatter'
import type { FreshnessGuard } from '../services/freshness-guard'

export function registerGetAuditHistory(server: McpServer): void {
  server.tool(
    'get_audit_history',
    'List prior MCP audit calls so you can decide whether to follow up. Returns the last successful invocation per (tool, canonical params) — agents use `lastCalledAt` plus the `followUp` block to query for "what is new since I last audited X." Use mode="raw" to see the unfiltered call log.',
    {
      project: z.string().optional().describe('Filter to one project slug'),
      toolName: z.string().optional().describe('Filter to a specific MCP tool, e.g. "analyze"'),
      paramsContains: z.string().optional().describe('Substring match against canonical params JSON (loose)'),
      since: z.string().optional().describe('ISO 8601 — only audits whose lastCalledAt is on/after this'),
      staleSince: z.string().optional().describe('ISO 8601 — only audits NOT touched since this (i.e. stale)'),
      mode: z.enum(['audits', 'raw']).optional().describe('audits = watermark view (default); raw = raw call log'),
      limit: z.number().int().min(1).max(500).optional().describe('Max results (default 50)'),
      sort: z.enum(['recent', 'stale', 'frequency']).optional().describe('Sort order — recent=default'),
    },
    async (params) => {
      const service = container.get<AuditHistoryService>(TOKENS.AuditHistoryService)
      const formatter = container.get<ResponseFormatter>(TOKENS.ResponseFormatter)
      const freshnessGuard = container.get<FreshnessGuard>(TOKENS.FreshnessGuard)

      const freshness = await freshnessGuard.ensureFresh()

      const results = service.query({
        project: params.project,
        toolName: params.toolName,
        paramsContains: params.paramsContains,
        since: params.since,
        staleSince: params.staleSince,
        mode: params.mode,
        limit: params.limit,
        sort: params.sort,
      })

      const meta = formatter.formatMeta(freshness)
      const response = formatter.format({ mode: params.mode ?? 'audits', results }, meta)
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      }
    }
  )
}
