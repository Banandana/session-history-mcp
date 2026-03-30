import { container } from 'tsyringe'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { TOKENS } from '../container/tokens'
import type { FreshnessGuard } from '../services/freshness-guard'
import type { AdapterRegistry } from '../services/adapter-registry'
import type { ResponseFormatter } from '../services/response-formatter'
import type { ProjectMeta } from '../types'

export function registerListProjects(server: McpServer): void {
  server.tool(
    'list_projects',
    'List all known projects with session counts, last activity, and memory/config status. Returns project slugs, paths, session counts, and whether they have memory or CLAUDE.md files.',
    {
      sortBy: z.enum(['recent', 'sessions', 'name']).optional().describe('Sort order: recent (last active), sessions (most sessions), name (alphabetical)'),
      limit: z.number().optional().describe('Maximum number of projects to return'),
    },
    async (params) => {
      const freshnessGuard = container.resolve<FreshnessGuard>(TOKENS.FreshnessGuard)
      const registry = container.resolve<AdapterRegistry>(TOKENS.AdapterRegistry)
      const formatter = container.resolve<ResponseFormatter>(TOKENS.ResponseFormatter)

      const freshness = await freshnessGuard.ensureFresh()

      const projects: ProjectMeta[] = []
      for await (const p of registry.discoverProjects()) {
        projects.push(p)
      }

      // Sort
      const sortBy = params.sortBy ?? 'recent'
      if (sortBy === 'name') {
        projects.sort((a, b) => a.slug.localeCompare(b.slug))
      } else if (sortBy === 'sessions') {
        projects.sort((a, b) => b.sessionCount - a.sessionCount)
      } else {
        // 'recent' — by lastActive descending
        projects.sort((a, b) => (b.lastActive ?? '').localeCompare(a.lastActive ?? ''))
      }

      const limited = params.limit ? projects.slice(0, params.limit) : projects

      const meta = formatter.formatMeta(freshness)
      const response = formatter.format(limited, meta)

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      }
    }
  )
}
