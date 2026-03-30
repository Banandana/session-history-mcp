import { container } from 'tsyringe'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { TOKENS } from '../container/tokens'
import type { FreshnessGuard } from '../services/freshness-guard'
import type { ResponseFormatter } from '../services/response-formatter'
import type { DatabaseConnection } from '../infrastructure/database'
import type { AdapterRegistry } from '../services/adapter-registry'
import type { NormalizedMessage } from '../types'
import { distillConversation } from '../services/conversation-distiller'
import type { LocalLlmClient } from '../services/local-llm-client'
import type { Focus } from '../types'

function formatTopTools(json: string): string {
  try {
    const counts = JSON.parse(json) as Record<string, number>
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, c]) => `${n}(${c})`).join(', ')
  } catch { return '' }
}

function formatFiles(json: string): string {
  try {
    const files = JSON.parse(json) as Array<{ path: string; op: string }>
    return files.slice(0, 5).map(f => `${f.path} (${f.op})`).join(', ')
  } catch { return '' }
}

export function registerGetSession(server: McpServer): void {
  server.tool(
    'get_session',
    'Get details for a specific session by ID. With detail=metadata or detail=full, includes turn count, file changes, and subagent information.',
    {
      sessionId: z.string().describe('Session ID (UUID)'),
      detail: z.enum(['summary', 'metadata', 'full']).optional().describe('Detail level'),
      focus: z.enum(['general', 'tools', 'errors', 'files', 'decisions']).optional().describe('Distillation lens for conversation sample (detail=full only)'),
      intent: z.string().max(500).optional().describe('Free-text analysis intent — triggers live LLM analysis (detail=full only)'),
    },
    async (params) => {
      const freshnessGuard = container.resolve<FreshnessGuard>(TOKENS.FreshnessGuard)
      const formatter = container.resolve<ResponseFormatter>(TOKENS.ResponseFormatter)
      const dbConn = container.resolve<DatabaseConnection>(TOKENS.Database)
      const db = dbConn.get()

      const freshness = await freshnessGuard.ensureFresh()

      // Look up session in index — read all stored columns
      const session = db.prepare(
        `SELECT id, source, project_slug, cwd, branch, started_at, ended_at,
                model, total_tokens, total_turns, message_count,
                duration_minutes, error_count, correction_count, subagent_count,
                tool_counts, files_changed, topic, summary, summary_generated_at
         FROM sessions WHERE id = ?`
      ).get(params.sessionId) as {
        id: string
        source: string
        project_slug: string | null
        cwd: string | null
        branch: string | null
        started_at: string | null
        ended_at: string | null
        model: string | null
        total_tokens: number
        total_turns: number
        message_count: number | null
        duration_minutes: number | null
        error_count: number | null
        correction_count: number | null
        subagent_count: number | null
        tool_counts: string | null
        files_changed: string | null
        topic: string | null
        summary: string | null
        summary_generated_at: string | null
      } | undefined

      if (!session) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Session not found: ${params.sessionId}` }, null, 2) }],
        }
      }

      const detail = params.detail ?? 'summary'

      // summary (default) — compact card matching list_sessions fields
      const result: Record<string, unknown> = {
        id: session.id,
        source: session.source,
        projectSlug: session.project_slug,
        cwd: session.cwd,
        branch: session.branch,
        startedAt: session.started_at,
        endedAt: session.ended_at,
        durationMinutes: session.duration_minutes,
        totalTurns: session.total_turns,
        totalTokens: session.total_tokens,
        errorCount: session.error_count,
        topic: session.topic,
        summary: session.summary,
      }

      if (detail === 'metadata' || detail === 'full') {
        result.messageCount = session.message_count
        result.correctionCount = session.correction_count
        result.subagentCount = session.subagent_count
        result.toolCounts = session.tool_counts ? JSON.parse(session.tool_counts) as unknown : null
        result.filesChanged = session.files_changed ? JSON.parse(session.files_changed) as unknown : null

        // Subagents from subagents table
        const subagents = db.prepare(
          'SELECT id, agent_type, description, total_tokens, total_tools, duration_ms, model FROM subagents WHERE session_id = ?'
        ).all(params.sessionId) as Array<{
          id: string
          agent_type: string | null
          description: string | null
          total_tokens: number
          total_tools: number
          duration_ms: number | null
          model: string | null
        }>
        result.subagents = subagents.map(sa => ({
          id: sa.id,
          agentType: sa.agent_type,
          description: sa.description,
          totalTokens: sa.total_tokens,
          totalTools: sa.total_tools,
          durationMs: sa.duration_ms,
          model: sa.model,
        }))
      }

      if (detail === 'full') {
        const registry = container.resolve<AdapterRegistry>(TOKENS.AdapterRegistry)
        const messages: NormalizedMessage[] = []
        for await (const msg of registry.getMessages(params.sessionId)) {
          messages.push(msg)
        }
        const focus: Focus = params.focus ?? 'general'
        const distilled = distillConversation(messages, { n: 10, focus })
        result.conversationSample = distilled.messages

        // Intent-based LLM analysis
        if (params.intent && messages.length >= 3) {
          try {
            const llmClient = container.resolve<LocalLlmClient>(TOKENS.LocalLlmClient)
            const available = await llmClient.isAvailable()
            if (available) {
              const metricsBlock = [
                `Duration: ${session.duration_minutes ?? 0} min, ${session.total_turns ?? 0} turns`,
                `Errors: ${session.error_count ?? 0}, Corrections: ${session.correction_count ?? 0}`,
                session.tool_counts ? `Tools: ${formatTopTools(session.tool_counts)}` : null,
                session.files_changed ? `Files: ${formatFiles(session.files_changed)}` : null,
              ].filter(Boolean).join('\n')

              const conversationBlock = distilled.messages
                .map(m => m.role === 'action' ? m.text : `${m.role}: ${m.text}`)
                .join('\n')

              const prompt = `You are analyzing a coding session for a specific purpose.\n\nCaller's intent: ${params.intent}\nFocus area: ${focus}\n\nSession metrics:\n${metricsBlock}\n\nConversation (${focus}-focused):\n${conversationBlock}\n\nAnswer:\n1. Is this session relevant to the caller's intent? (yes/no)\n2. If relevant, explain specifically how — cite concrete details.\n3. If not relevant, say what the session was actually about in one sentence.\n\nBe concise.`

              const llmResponse = await llmClient.summarize(prompt, 300)
              const relevant = !llmResponse.toLowerCase().startsWith('no')
              result.analysis = {
                relevant,
                summary: llmResponse,
                generatedAt: new Date().toISOString(),
              }
            } else {
              result.analysis = null
            }
          } catch {
            result.analysis = null
          }
        } else if (params.intent && messages.length < 3) {
          result.analysis = { relevant: false, summary: 'Too few messages for analysis', reason: 'too_few_messages' }
        }
      }

      const meta = formatter.formatMeta(freshness)
      const response = formatter.format(result, meta)

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      }
    }
  )
}
