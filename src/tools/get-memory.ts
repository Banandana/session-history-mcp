import { container } from 'tsyringe'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { TOKENS } from '../container/tokens'
import type { AdapterRegistry } from '../services/adapter-registry'
import type { ProjectResolver } from '../services/project-resolver'
import type { ResponseFormatter } from '../services/response-formatter'
import type { MemoryEntry } from '../types'

export function registerGetMemory(server: McpServer): void {
  server.tool(
    'get_memory',
    'Access cross-project memory entries (CLAUDE.md content). Filter by project, type, or search within memory content.',
    {
      project: z.string().optional().describe('Filter by project slug'),
      path: z.string().optional().describe('Resolve project from filesystem path'),
      type: z.enum(['user', 'feedback', 'project', 'reference']).optional().describe('Filter by memory type'),
      search: z.string().optional().describe('Text search within memory content'),
    },
    async (params) => {
      const registry = container.resolve<AdapterRegistry>(TOKENS.AdapterRegistry)
      const projectResolver = container.resolve<ProjectResolver>(TOKENS.ProjectResolver)
      const formatter = container.resolve<ResponseFormatter>(TOKENS.ResponseFormatter)

      const projectSlug = await projectResolver.resolveProjectFilter({
        project: params.project,
        path: params.path,
      })

      let entries: MemoryEntry[] = []
      for await (const entry of registry.getMemory(projectSlug)) {
        entries.push(entry)
      }

      if (params.type) {
        entries = entries.filter(e => e.type === params.type)
      }

      if (params.search) {
        const searchLower = params.search.toLowerCase()
        entries = entries.filter(e => e.content.toLowerCase().includes(searchLower))
      }

      const meta = {
        indexedAt: new Date().toISOString(),
        sessionCount: 0,
        staleSessions: 0,
        syncDurationMs: 0,
      }

      const response = formatter.format(entries, meta)

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      }
    }
  )
}
