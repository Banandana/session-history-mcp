import { container } from 'tsyringe'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { join } from 'node:path'
import { TOKENS } from '../container/tokens'
import type { FreshnessGuard } from '../services/freshness-guard'
import type { TokenBudgetManager } from '../services/token-budget-manager'
import type { PaginationManager } from '../services/pagination-manager'
import type { ResponseFormatter } from '../services/response-formatter'
import type { DatabaseConnection } from '../infrastructure/database'
import type { NormalizedMessage, ContentBlock } from '../types'
import { ConversationParser } from '../adapters/claude-code/conversation-parser'
import { distillConversation } from '../services/conversation-distiller'

export function registerGetConversation(server: McpServer): void {
  server.tool(
    'get_conversation',
    'Get conversation content for a session with token budgeting, role filtering, and windowed views (start, end, errors, corrections).',
    {
      sessionId: z.string().describe('Session ID'),
      maxTokens: z.number().optional().describe('Token budget for response'),
      roles: z.array(z.enum(['user', 'assistant', 'system'])).optional().describe('Filter by role'),
      includeToolResults: z.boolean().optional().describe('Include tool result content'),
      window: z.enum(['start', 'end', 'errors', 'corrections']).optional().describe('Which part of conversation to return'),
      cursor: z.string().optional().describe('Pagination cursor'),
      limit: z.number().optional().describe('Maximum messages to return'),
      focus: z.enum(['general', 'tools', 'errors', 'files', 'decisions']).optional().describe('Distillation lens — adds distilled view alongside raw messages (ignored when includeToolResults=true)'),
    },
    async (params) => {
      const freshnessGuard = container.resolve<FreshnessGuard>(TOKENS.FreshnessGuard)
      const tokenBudget = container.resolve<TokenBudgetManager>(TOKENS.TokenBudgetManager)
      const pagination = container.resolve<PaginationManager>(TOKENS.PaginationManager)
      const formatter = container.resolve<ResponseFormatter>(TOKENS.ResponseFormatter)
      const dbConn = container.resolve<DatabaseConnection>(TOKENS.Database)
      const db = dbConn.get()
      const claudeDir = container.resolve<string>(TOKENS.ClaudeDataDir)

      const freshness = await freshnessGuard.ensureFresh()

      // Find session to get project_slug
      const session = db.prepare(
        'SELECT project_slug FROM sessions WHERE id = ?'
      ).get(params.sessionId) as { project_slug: string | null } | undefined

      if (!session) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Session not found: ${params.sessionId}` }, null, 2) }],
        }
      }

      // Construct JSONL path
      const projectSlug = session.project_slug ?? 'unknown'
      const sessionPath = join(claudeDir, 'projects', projectSlug, `${params.sessionId}.jsonl`)

      // Parse messages from JSONL
      const parser = new ConversationParser()
      let messages: NormalizedMessage[] = []
      try {
        for await (const msg of parser.parseSession(sessionPath)) {
          messages.push(msg)
        }
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Failed to read session file: ${(err as Error).message}` }, null, 2) }],
        }
      }

      // Filter by roles
      if (params.roles && params.roles.length > 0) {
        const roleSet = new Set(params.roles)
        messages = messages.filter(m => roleSet.has(m.role))
      }

      // Filter by window
      if (params.window) {
        messages = [...tokenBudget.filterByWindow(messages, params.window)]
      }

      // Strip tool_result content if not requested
      if (!params.includeToolResults) {
        messages = messages.map(msg => {
          const hasToolResult = msg.contentBlocks.some(b => b.type === 'tool_result')
          if (!hasToolResult) return msg

          const strippedBlocks: ContentBlock[] = msg.contentBlocks.map(b => {
            if (b.type === 'tool_result') {
              return { type: 'tool_result' as const, tool_use_id: b.tool_use_id }
            }
            return b
          })

          return { ...msg, contentBlocks: strippedBlocks }
        })
      }

      // Apply token budget
      let truncated = false
      let totalMessages = messages.length
      if (params.maxTokens) {
        const budgetResult = tokenBudget.fitWithinBudget(messages, params.maxTokens)
        messages = [...budgetResult.messages]
        truncated = budgetResult.truncated
        totalMessages = budgetResult.totalMessages
      }

      // Apply pagination
      const page = pagination.paginate(messages, {
        cursor: params.cursor,
        limit: params.limit,
      })

      const meta = formatter.formatMeta(freshness)
      const paginationResult = page.hasMore
        ? { cursor: page.cursor!, hasMore: true, totalEstimate: page.totalEstimate }
        : { cursor: '', hasMore: false, totalEstimate: page.totalEstimate }

      let distilled = undefined
      if (params.focus && !params.includeToolResults) {
        const distillResult = distillConversation(page.items, { focus: params.focus })
        distilled = distillResult.messages
      }

      const data = {
        sessionId: params.sessionId,
        messages: page.items,
        distilled,
        totalMessages,
        truncated,
      }

      const response = formatter.format(data, meta, paginationResult)

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      }
    }
  )
}
