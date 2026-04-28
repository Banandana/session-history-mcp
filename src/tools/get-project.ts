import { container } from 'tsyringe'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { TOKENS } from '../container/tokens'
import type { FreshnessGuard } from '../services/freshness-guard'
import type { AdapterRegistry } from '../services/adapter-registry'
import type { ProjectResolver } from '../services/project-resolver'
import type { ResponseFormatter } from '../services/response-formatter'
import type { AuditHistoryService } from '../services/audit-history'
import type { ProjectMeta, MemoryEntry } from '../types'
import { ConfigReader } from '../adapters/claude-code/config-reader'
import { MemoryReader } from '../adapters/claude-code/memory-reader'

export function registerGetProject(server: McpServer): void {
  server.tool(
    'get_project',
    'Get details for a specific project by slug or filesystem path. With detail=full, includes CLAUDE.md content, settings, and memory entries.',
    {
      project: z.string().optional().describe('Project slug'),
      path: z.string().optional().describe('Filesystem path to project or subdirectory'),
      detail: z.enum(['summary', 'full']).optional().describe('Detail level'),
    },
    async (params) => {
      const freshnessGuard = container.resolve<FreshnessGuard>(TOKENS.FreshnessGuard)
      const registry = container.resolve<AdapterRegistry>(TOKENS.AdapterRegistry)
      const projectResolver = container.resolve<ProjectResolver>(TOKENS.ProjectResolver)
      const formatter = container.resolve<ResponseFormatter>(TOKENS.ResponseFormatter)
      const auditHistory = container.resolve<AuditHistoryService>(TOKENS.AuditHistoryService)

      const freshness = await freshnessGuard.ensureFresh()

      const slug = await projectResolver.resolveProjectFilter({
        project: params.project,
        path: params.path,
      })

      if (!slug) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Could not resolve project. Provide a valid project slug or path.' }, null, 2) }],
        }
      }

      // Find matching project
      let foundProject: ProjectMeta | undefined
      for await (const p of registry.discoverProjects()) {
        if (p.slug === slug) {
          foundProject = p
          break
        }
      }

      if (!foundProject) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Project not found: ${slug}` }, null, 2) }],
        }
      }

      const detail = params.detail ?? 'summary'

      const recentAudits = auditHistory.recentForProject([slug, foundProject.path], 10)

      if (detail === 'full') {
        const claudeDir = container.resolve<string>(TOKENS.ClaudeDataDir)
        const configReader = new ConfigReader(claudeDir)
        const memoryReader = new MemoryReader(claudeDir)

        const claudeMd = await configReader.readProjectClaudeMd(foundProject.path)
        const settings = await configReader.readSettings()

        const memoryEntries: MemoryEntry[] = []
        for await (const entry of memoryReader.readMemory(slug)) {
          memoryEntries.push(entry)
        }

        // Get session list for the project
        const sessions: Array<{ id: string; startedAt: string; model?: string }> = []
        for await (const s of registry.discoverSessions(slug)) {
          sessions.push({ id: s.id, startedAt: s.startedAt, model: s.model })
        }

        const fullResult = {
          ...foundProject,
          claudeMd,
          settings,
          memoryEntries,
          sessions,
          recentAudits,
        }

        const meta = formatter.formatMeta(freshness)
        const response = formatter.format(fullResult, meta)
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
        }
      }

      const meta = formatter.formatMeta(freshness)
      const response = formatter.format({ ...foundProject, recentAudits }, meta)
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      }
    }
  )
}
