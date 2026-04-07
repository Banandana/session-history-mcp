import { container } from 'tsyringe'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { join } from 'node:path'
import { TOKENS } from '../container/tokens'
import type { FreshnessGuard } from '../services/freshness-guard'
import type { ResponseFormatter } from '../services/response-formatter'
import type { DatabaseConnection } from '../infrastructure/database'
import type { NormalizedMessage } from '../types'
import type { FallbackLlmClient } from '../services/llm-client'
import { ConversationParser } from '../adapters/claude-code/conversation-parser'

function validateSessionId(id: string): boolean {
  return /^[a-f0-9-]{32,40}$/i.test(id)
}

function formatMessage(msg: NormalizedMessage, index: number): string {
  const parts: string[] = []
  parts.push(`[${index}] ${msg.role} @ ${msg.timestamp}`)
  if (msg.model) parts[0] += ` (${msg.model})`

  for (const block of msg.contentBlocks) {
    if (block.type === 'text' && block.text) {
      parts.push(block.text)
    } else if (block.type === 'tool_use' && block.name) {
      const inputStr = block.input ? JSON.stringify(block.input) : ''
      // Truncate very large tool inputs
      const truncated = inputStr.length > 2000 ? inputStr.slice(0, 2000) + '...[truncated]' : inputStr
      parts.push(`→ ${block.name}(${truncated})`)
    } else if (block.type === 'tool_result') {
      const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
      // Truncate very large results
      const truncated = content.length > 3000 ? content.slice(0, 3000) + '...[truncated]' : content
      parts.push(`← ${truncated}`)
    }
    // Skip thinking blocks — they're huge and the model can infer reasoning from actions
  }

  if (msg.isError) parts.push('[ERROR]')
  if (msg.isCorrection) parts.push('[CORRECTION]')

  return parts.join('\n')
}

const SYSTEM_PROMPT = `You are analyzing a complete Claude Code session transcript. This is an expensive, thorough analysis — examine everything.

Produce a structured analysis covering:

## Session Summary
What the user wanted, what was accomplished, the overall arc.

## Quality Assessment
- Decision quality: Were the right approaches chosen? Were there unnecessary detours?
- Tool usage: Were tools used efficiently? Any misuse or missed opportunities?
- Error handling: How were errors handled? Were they diagnosed properly or blindly retried?
- User corrections: What did the user have to correct? Were the corrections warranted?
- Context management: Did the session stay focused or lose context?

## Behavioral Patterns
- Recurring mistakes or anti-patterns
- Successful strategies that worked well
- Moments where the agent adapted well vs. where it was rigid

## Token Efficiency
- Was work done efficiently or were tokens wasted on unnecessary operations?
- Could parallelization have been used more?
- Were there unnecessary re-reads or redundant searches?

## Recommendations
Concrete, actionable lessons that should inform future sessions. Focus on patterns, not one-off fixes.

Be direct and specific. Reference turn numbers when citing examples. Don't soften criticism — accuracy matters more than politeness.`

export function registerDeepAnalyze(server: McpServer): void {
  server.tool(
    'deep_analyze',
    'Send an entire session to Opus for comprehensive analysis. Expensive — uses Anthropic API with full session context. Returns quality assessment, behavioral patterns, token efficiency, and actionable recommendations.',
    {
      sessionId: z.string().describe('Session ID to analyze'),
      focus: z.string().max(500).optional().describe('Optional focus area for the analysis (e.g., "error handling patterns", "tool selection decisions")'),
      maxResponseTokens: z.number().optional().describe('Max tokens for analysis response (default: 16384)'),
    },
    async (params) => {
      const freshnessGuard = container.resolve<FreshnessGuard>(TOKENS.FreshnessGuard)
      const formatter = container.resolve<ResponseFormatter>(TOKENS.ResponseFormatter)
      const dbConn = container.resolve<DatabaseConnection>(TOKENS.Database)
      const llmClient = container.resolve<FallbackLlmClient>(TOKENS.LlmClient)
      const db = dbConn.get()
      const claudeDir = container.resolve<string>(TOKENS.ClaudeDataDir)

      const freshness = await freshnessGuard.ensureFresh()

      // Require Anthropic API specifically — this is an expensive operation
      if (!(await llmClient.isAvailable())) {
        const reason = 'deep_analyze requires ANTHROPIC_API_KEY. Set it in the environment where the MCP server runs.'
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: reason }, null, 2),
          }],
        }
      }
      const anthropic = llmClient.getAnthropicClient()
      if (!anthropic) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: 'deep_analyze requires ANTHROPIC_API_KEY. Set it in the environment where the MCP server runs.',
            }, null, 2),
          }],
        }
      }

      if (!validateSessionId(params.sessionId)) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Invalid session ID format: ${params.sessionId}` }, null, 2) }],
        }
      }

      // Look up session
      const session = db.prepare(
        `SELECT project_slug, topic, started_at, ended_at, duration_minutes,
                total_tokens, total_turns, error_count, correction_count,
                cost_usd, models_used, tool_counts, files_changed,
                custom_title, ai_title, mode
         FROM sessions WHERE id = ?`
      ).get(params.sessionId) as Record<string, unknown> | undefined

      if (!session) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Session not found: ${params.sessionId}` }, null, 2) }],
        }
      }

      // Load full session transcript
      const projectSlug = (session.project_slug as string) ?? 'unknown'
      const sessionPath = join(claudeDir, 'projects', projectSlug, `${params.sessionId}.jsonl`)

      const parser = new ConversationParser()
      const messages: NormalizedMessage[] = []
      try {
        for await (const msg of parser.parseSession(sessionPath)) {
          messages.push(msg)
        }
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Failed to read session: ${(err as Error).message}` }, null, 2) }],
        }
      }

      // Build the full transcript
      const metadataBlock = [
        `Session: ${params.sessionId}`,
        `Title: ${session.custom_title ?? session.ai_title ?? session.topic ?? 'untitled'}`,
        `Duration: ${session.duration_minutes ?? 0} min, ${session.total_turns ?? messages.length} turns`,
        `Errors: ${session.error_count ?? 0}, Corrections: ${session.correction_count ?? 0}`,
        `Models: ${session.models_used ?? 'unknown'}`,
        `Cost: ${session.cost_usd != null ? `$${(session.cost_usd as number).toFixed(4)}` : 'unknown'}`,
        session.tool_counts ? `Tools: ${session.tool_counts}` : null,
        session.files_changed ? `Files changed: ${session.files_changed}` : null,
        session.mode ? `Mode: ${session.mode}` : null,
      ].filter(Boolean).join('\n')

      const transcriptLines = messages.map((msg, i) => formatMessage(msg, i))
      const transcript = transcriptLines.join('\n\n---\n\n')

      const userContent = `${metadataBlock}\n\n${'='.repeat(80)}\nFULL TRANSCRIPT (${messages.length} turns)\n${'='.repeat(80)}\n\n${transcript}`

      // Build system prompt with optional focus
      let systemPrompt = SYSTEM_PROMPT
      if (params.focus) {
        systemPrompt += `\n\n## Special Focus\nThe caller wants particular attention on: ${params.focus}\nDedicate extra analysis to this area.`
      }

      const maxResponseTokens = params.maxResponseTokens ?? 16384

      try {
        const analysis = await anthropic.analyze(systemPrompt, userContent, maxResponseTokens)

        const data = {
          sessionId: params.sessionId,
          title: session.custom_title ?? session.ai_title ?? session.topic,
          analyzedTurns: messages.length,
          focus: params.focus ?? null,
          model: anthropic.label,
          analysis,
        }

        const meta = formatter.formatMeta(freshness)
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(formatter.format(data, meta), null, 2) }],
        }
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Analysis failed: ${(err as Error).message}` }, null, 2) }],
        }
      }
    }
  )
}
