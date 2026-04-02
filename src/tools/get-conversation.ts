import { container } from 'tsyringe'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { join } from 'node:path'
import { TOKENS } from '../container/tokens'
import type { FreshnessGuard } from '../services/freshness-guard'
import type { ResponseFormatter } from '../services/response-formatter'
import type { DatabaseConnection } from '../infrastructure/database'
import type { PhaseClusterer, Phase } from '../services/phase-clusterer'
import type { NormalizedMessage } from '../types'
import { ConversationParser } from '../adapters/claude-code/conversation-parser'

interface SessionRow {
  readonly project_slug: string | null
  readonly topic: string | null
  readonly summary: string | null
  readonly started_at: string | null
  readonly ended_at: string | null
  readonly duration_minutes: number | null
  readonly model: string | null
  readonly total_tokens: number | null
  readonly total_turns: number | null
  readonly error_count: number | null
  readonly correction_count: number | null
  readonly tool_counts: string | null
  readonly files_changed: string | null
}

export function registerGetConversation(server: McpServer): void {
  server.tool(
    'get_conversation',
    'Get a phase-clustered overview of a session — metadata, tool breakdown, files changed, and activity phases.',
    {
      sessionId: z.string().describe('Session ID'),
      maxTokens: z.number().optional().describe('Token budget for response — truncates phases and lists to fit'),
    },
    async (params) => {
      const freshnessGuard = container.resolve<FreshnessGuard>(TOKENS.FreshnessGuard)
      const formatter = container.resolve<ResponseFormatter>(TOKENS.ResponseFormatter)
      const dbConn = container.resolve<DatabaseConnection>(TOKENS.Database)
      const phaseClusterer = container.resolve<PhaseClusterer>(TOKENS.PhaseClusterer)
      const db = dbConn.get()
      const claudeDir = container.resolve<string>(TOKENS.ClaudeDataDir)

      const freshness = await freshnessGuard.ensureFresh()

      const session = db.prepare(
        `SELECT project_slug, topic, summary, started_at, ended_at, duration_minutes,
                model, total_tokens, total_turns, error_count, correction_count,
                tool_counts, files_changed
         FROM sessions WHERE id = ?`
      ).get(params.sessionId) as SessionRow | undefined

      if (!session) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Session not found: ${params.sessionId}` }, null, 2) }],
        }
      }

      // Construct JSONL path and parse messages
      const projectSlug = session.project_slug ?? 'unknown'
      const sessionPath = join(claudeDir, 'projects', projectSlug, `${params.sessionId}.jsonl`)

      const parser = new ConversationParser()
      const messages: NormalizedMessage[] = []
      try {
        for await (const msg of parser.parseSession(sessionPath)) {
          messages.push(msg)
        }
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Failed to read session file: ${(err as Error).message}` }, null, 2) }],
        }
      }

      // Cluster into phases
      let phases: Phase[] = [...phaseClusterer.cluster(messages)]

      // Parse tool_counts and files_changed from JSON strings
      let toolCounts: Record<string, number> = {}
      if (session.tool_counts) {
        try {
          toolCounts = JSON.parse(session.tool_counts) as Record<string, number>
        } catch {
          // ignore malformed JSON
        }
      }

      let filesChanged: string[] = []
      if (session.files_changed) {
        try {
          filesChanged = JSON.parse(session.files_changed) as string[]
        } catch {
          // ignore malformed JSON
        }
      }

      // Apply maxTokens budget enforcement
      if (params.maxTokens) {
        const estimateTokens = (obj: unknown) => Math.ceil(JSON.stringify(obj).length / 4)

        // 1. Truncate filesChanged to top 10
        if (filesChanged.length > 10) filesChanged = filesChanged.slice(0, 10)

        // 2. Truncate toolBreakdown to top 10 by count
        if (Object.keys(toolCounts).length > 10) {
          const sorted = Object.entries(toolCounts).sort((a, b) => (b[1] as number) - (a[1] as number))
          toolCounts = Object.fromEntries(sorted.slice(0, 10))
        }

        // 3. Merge smallest adjacent phases until under budget
        while (phases.length > 2 && estimateTokens({ phases }) > params.maxTokens * 0.7) {
          let smallestIdx = 0
          let smallestCount = Infinity
          for (let i = 0; i < phases.length; i++) {
            if (phases[i].turnCount < smallestCount) {
              smallestCount = phases[i].turnCount
              smallestIdx = i
            }
          }
          const mergeIdx = smallestIdx === 0 ? 1
            : smallestIdx === phases.length - 1 ? smallestIdx - 1
            : phases[smallestIdx - 1].turnCount <= phases[smallestIdx + 1].turnCount ? smallestIdx - 1 : smallestIdx + 1
          const [a, b] = mergeIdx < smallestIdx ? [mergeIdx, smallestIdx] : [smallestIdx, mergeIdx]
          const mergedTools = new Set([...phases[a].toolNames, ...phases[b].toolNames])
          phases[a] = {
            turnRange: { from: phases[a].turnRange.from, to: phases[b].turnRange.to },
            description: phases[a].description,
            toolNames: [...mergedTools],
            errorCount: phases[a].errorCount + phases[b].errorCount,
            turnCount: phases[a].turnCount + phases[b].turnCount,
          }
          phases.splice(b, 1)
        }
      }

      const data = {
        sessionId: params.sessionId,
        metadata: {
          topic: session.topic,
          summary: session.summary,
          startedAt: session.started_at,
          endedAt: session.ended_at,
          durationMinutes: session.duration_minutes,
          model: session.model,
          totalTurns: session.total_turns ?? messages.length,
          totalTokens: session.total_tokens,
          errorCount: session.error_count ?? 0,
          correctionCount: session.correction_count ?? 0,
          toolBreakdown: toolCounts,
          filesChanged,
        },
        phases,
      }

      const meta = formatter.formatMeta(freshness)
      const response = formatter.format(data, meta)

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      }
    }
  )
}
