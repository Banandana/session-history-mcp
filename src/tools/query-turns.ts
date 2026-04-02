import { container } from 'tsyringe'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { join } from 'node:path'
import { TOKENS } from '../container/tokens'
import type { FreshnessGuard } from '../services/freshness-guard'
import type { ResponseFormatter } from '../services/response-formatter'
import type { DatabaseConnection } from '../infrastructure/database'
import type { TurnIndexer } from '../services/turn-indexer'
import type { NormalizedMessage, ContentBlock, MessageRole } from '../types'
import type { TurnReference } from '../types/conversation'
import { extractToolParams } from '../services/tool-summary'
import { ConversationParser } from '../adapters/claude-code/conversation-parser'
import type Database from 'better-sqlite3'

// ── Types ──────────────────────────────────────────────────────────────────────

interface TurnFilters {
  readonly toolNames?: readonly string[]
  readonly isError?: boolean
  readonly isCorrection?: boolean
  readonly roles?: readonly MessageRole[]
  readonly textPattern?: string
  readonly timeRange?: { readonly after?: string; readonly before?: string }
  readonly turnRange?: { readonly from?: number; readonly to?: number }
}

interface FilterResult {
  readonly matches: boolean
  readonly matchContext?: string
}

interface SessionRow {
  readonly project_slug: string | null
}

interface UnindexedSessionRow {
  readonly id: string
  readonly project_slug: string | null
}

interface TurnEventRow {
  readonly session_id: string
  readonly turn_index: number
  readonly turn_id: string
  readonly role: string
  readonly timestamp: string
  readonly tool_names: string
  readonly is_error: number
  readonly is_correction: number
  readonly text_preview: string | null
}

// ── Helpers ────────────────────────────────────────────────────────────────────

export function parseToolNames(json: string): readonly string[] {
  try {
    const parsed = JSON.parse(json) as string[]
    return parsed.length > 0 ? parsed : []
  } catch {
    return []
  }
}

export function summarizeFromDbRow(isError: boolean, toolNames: readonly string[], textPreview: string | null): string {
  if (isError && textPreview) {
    const truncated = textPreview.length > 120 ? textPreview.slice(0, 120) + '...' : textPreview
    return `[error: ${truncated}]`
  }
  if (toolNames.length > 1) return `[${toolNames.join(', ')}]`
  if (toolNames.length === 1) return `[${toolNames[0]}]`
  if (textPreview) return textPreview.length > 120 ? textPreview.slice(0, 120) + '...' : textPreview
  return ''
}

function getTextContent(blocks: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (block.type === 'text' && block.text) {
      parts.push(block.text)
    }
    if (block.type === 'tool_result' && block.content) {
      if (typeof block.content === 'string') {
        parts.push(block.content)
      }
    }
  }
  return parts.join(' ')
}

export function summarizeMessage(msg: NormalizedMessage): string {
  // Error turns: show error text
  if (msg.isError) {
    const text = getTextContent(msg.contentBlocks)
    if (text) {
      const truncated = text.length > 120 ? text.slice(0, 120) + '...' : text
      return `[error: ${truncated}]`
    }
    return '[error]'
  }

  // Multi-tool turns
  const toolUseBlocks = msg.contentBlocks.filter(b => b.type === 'tool_use' && b.name)
  if (toolUseBlocks.length > 1) {
    const names = toolUseBlocks.map(b => b.name!)
    return `[${names.join(', ')}]`
  }

  // Single tool with params
  if (toolUseBlocks.length === 1) {
    const block = toolUseBlocks[0]
    return `[${extractToolParams(block.name!, block.input)}]`
  }

  // Text-only
  const text = getTextContent(msg.contentBlocks)
  if (text) {
    return text.length > 120 ? text.slice(0, 120) + '...' : text
  }

  return ''
}

export function messageMatchesFilters(
  msg: NormalizedMessage,
  index: number,
  filters: TurnFilters,
): FilterResult {
  // Role filter
  if (filters.roles && filters.roles.length > 0) {
    if (!filters.roles.includes(msg.role)) return { matches: false }
  }

  // Error filter
  if (filters.isError !== undefined) {
    if (msg.isError !== filters.isError) return { matches: false }
  }

  // Correction filter
  if (filters.isCorrection !== undefined) {
    if (msg.isCorrection !== filters.isCorrection) return { matches: false }
  }

  // Tool names filter (any match)
  if (filters.toolNames && filters.toolNames.length > 0) {
    const msgTools = msg.toolNames ?? []
    const hasMatch = filters.toolNames.some(t => msgTools.includes(t))
    if (!hasMatch) return { matches: false }
  }

  // Turn range filter
  if (filters.turnRange) {
    const { from, to } = filters.turnRange
    if (from !== undefined && index < from) return { matches: false }
    if (to !== undefined && index > to) return { matches: false }
  }

  // Time range filter
  if (filters.timeRange) {
    const { after, before } = filters.timeRange
    if (after && msg.timestamp < after) return { matches: false }
    if (before && msg.timestamp > before) return { matches: false }
  }

  // Text pattern filter
  if (filters.textPattern) {
    const text = getTextContent(msg.contentBlocks)
    const regex = new RegExp(filters.textPattern, 'i')
    const match = regex.exec(text)
    if (!match) return { matches: false }

    // Extract snippet around match
    const start = Math.max(0, match.index - 30)
    const end = Math.min(text.length, match.index + match[0].length + 30)
    const snippet = (start > 0 ? '...' : '') + text.slice(start, end) + (end < text.length ? '...' : '')
    return { matches: true, matchContext: snippet }
  }

  return { matches: true }
}

// ── Single-session query ───────────────────────────────────────────────────────

async function querySingleSession(
  sessionId: string,
  db: Database.Database,
  claudeDir: string,
  filters: TurnFilters,
  limit: number,
  offset: number,
): Promise<{ readonly results: readonly TurnReference[]; readonly total: number }> {
  const session = db.prepare(
    'SELECT project_slug FROM sessions WHERE id = ?'
  ).get(sessionId) as SessionRow | undefined

  if (!session) {
    return { results: [], total: 0 }
  }

  const projectSlug = session.project_slug ?? 'unknown'
  const sessionPath = join(claudeDir, 'projects', projectSlug, `${sessionId}.jsonl`)

  const parser = new ConversationParser()
  const messages: NormalizedMessage[] = []
  try {
    for await (const msg of parser.parseSession(sessionPath)) {
      messages.push(msg)
    }
  } catch {
    return { results: [], total: 0 }
  }

  const matched: TurnReference[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    const result = messageMatchesFilters(msg, i, filters)
    if (result.matches) {
      matched.push({
        sessionId,
        turnIndex: i,
        turnId: msg.uuid,
        role: msg.role,
        timestamp: msg.timestamp,
        summary: summarizeMessage(msg),
        isError: msg.isError,
        isCorrection: msg.isCorrection,
        toolNames: msg.toolNames ?? [],
        matchContext: result.matchContext,
      })
    }
  }

  const paginated = matched.slice(offset, offset + limit)
  return { results: paginated, total: matched.length }
}

// ── Cross-session query ────────────────────────────────────────────────────────

async function ensureTurnEventsIndexed(
  projectId: string,
  db: Database.Database,
  claudeDir: string,
): Promise<void> {
  const unindexed = db.prepare(
    `SELECT id, project_slug FROM sessions
     WHERE project_slug = ? AND turn_events_indexed = 0`
  ).all(projectId) as readonly UnindexedSessionRow[]

  if (unindexed.length === 0) return

  const turnIndexer = container.resolve<TurnIndexer>(TOKENS.TurnIndexer)
  const parser = new ConversationParser()

  for (const session of unindexed) {
    const projectSlug = session.project_slug ?? 'unknown'
    const sessionPath = join(claudeDir, 'projects', projectSlug, `${session.id}.jsonl`)

    try {
      const messages: NormalizedMessage[] = []
      for await (const msg of parser.parseSession(sessionPath)) {
        messages.push(msg)
      }
      turnIndexer.indexSession(session.id, messages)
    } catch {
      // Skip sessions with missing/corrupt JSONL
      continue
    }
  }
}

function queryCrossSession(
  projectId: string,
  db: Database.Database,
  filters: TurnFilters,
  limit: number,
  offset: number,
): { readonly results: readonly TurnReference[]; readonly total: number } {
  const conditions: string[] = ['s.project_slug = ?']
  const params: unknown[] = [projectId]

  if (filters.roles && filters.roles.length > 0) {
    const placeholders = filters.roles.map(() => '?').join(', ')
    conditions.push(`t.role IN (${placeholders})`)
    params.push(...filters.roles)
  }

  if (filters.isError !== undefined) {
    conditions.push('t.is_error = ?')
    params.push(filters.isError ? 1 : 0)
  }

  if (filters.isCorrection !== undefined) {
    conditions.push('t.is_correction = ?')
    params.push(filters.isCorrection ? 1 : 0)
  }

  if (filters.toolNames && filters.toolNames.length > 0) {
    // Use json_each to check if any of the tool names match
    const toolConditions = filters.toolNames.map(() =>
      `EXISTS (SELECT 1 FROM json_each(t.tool_names) WHERE json_each.value = ?)`
    )
    conditions.push(`(${toolConditions.join(' OR ')})`)
    params.push(...filters.toolNames)
  }

  if (filters.timeRange) {
    if (filters.timeRange.after) {
      conditions.push('t.timestamp >= ?')
      params.push(filters.timeRange.after)
    }
    if (filters.timeRange.before) {
      conditions.push('t.timestamp <= ?')
      params.push(filters.timeRange.before)
    }
  }

  const where = conditions.join(' AND ')

  const countRow = db.prepare(
    `SELECT COUNT(*) as cnt FROM turn_events t
     JOIN sessions s ON s.id = t.session_id
     WHERE ${where}`
  ).get(...params) as { cnt: number }

  const rows = db.prepare(
    `SELECT t.session_id, t.turn_index, t.turn_id, t.role, t.timestamp,
            t.tool_names, t.is_error, t.is_correction, t.text_preview
     FROM turn_events t
     JOIN sessions s ON s.id = t.session_id
     WHERE ${where}
     ORDER BY t.timestamp DESC
     LIMIT ? OFFSET ?`
  ).all(...params, limit, offset) as readonly TurnEventRow[]

  const results: TurnReference[] = rows.map(row => {
    const toolNames = parseToolNames(row.tool_names)
    const summary = summarizeFromDbRow(row.is_error === 1, toolNames, row.text_preview)

    return {
      sessionId: row.session_id,
      turnIndex: row.turn_index,
      turnId: row.turn_id,
      role: row.role as MessageRole,
      timestamp: row.timestamp,
      summary,
      isError: row.is_error === 1,
      isCorrection: row.is_correction === 1,
      toolNames,
    }
  })

  return { results, total: countRow.cnt }
}

// ── Tool registration ──────────────────────────────────────────────────────────

export function registerQueryTurns(server: McpServer): void {
  server.tool(
    'query_turns',
    'Search for turns matching structured criteria within a session (JSONL) or across sessions (DB). Returns lightweight turn references with summaries. Use get_turns to expand specific results.',
    {
      sessionId: z.string().optional().describe('Scope to one session (enables textPattern and turnRange)'),
      projectId: z.string().optional().describe('Scope to a project for cross-session search'),
      toolNames: z.array(z.string()).optional().describe('Filter turns containing any of these tools'),
      isError: z.boolean().optional().describe('Only error turns'),
      isCorrection: z.boolean().optional().describe('Only correction turns'),
      roles: z.array(z.enum(['user', 'assistant'])).optional().describe('Filter by role'),
      textPattern: z.string().optional().describe('Regex match against turn text (single-session only, requires sessionId)'),
      timeRange: z.object({
        after: z.string().optional().describe('ISO timestamp lower bound'),
        before: z.string().optional().describe('ISO timestamp upper bound'),
      }).optional().describe('Time range filter'),
      turnRange: z.object({
        from: z.number().optional().describe('Start turn index (inclusive)'),
        to: z.number().optional().describe('End turn index (inclusive)'),
      }).optional().describe('Turn index range (single-session only, requires sessionId)'),
      limit: z.number().optional().describe('Max results (default 50)'),
      cursor: z.string().optional().describe('Offset-based pagination cursor'),
    },
    async (params) => {
      const freshnessGuard = container.resolve<FreshnessGuard>(TOKENS.FreshnessGuard)
      const formatter = container.resolve<ResponseFormatter>(TOKENS.ResponseFormatter)
      const dbConn = container.resolve<DatabaseConnection>(TOKENS.Database)
      const db = dbConn.get()
      const claudeDir = container.resolve<string>(TOKENS.ClaudeDataDir)

      // Validate constraints
      if (!params.sessionId && !params.projectId) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'At least one of sessionId or projectId is required',
          }, null, 2) }],
        }
      }

      if (params.textPattern && !params.sessionId) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'textPattern requires sessionId (no cross-session text search)',
          }, null, 2) }],
        }
      }

      if (params.turnRange && !params.sessionId) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'turnRange requires sessionId',
          }, null, 2) }],
        }
      }

      const freshness = await freshnessGuard.ensureFresh()
      const limit = params.limit ?? 50
      const offset = params.cursor ? parseInt(params.cursor, 10) : 0

      const filters: TurnFilters = {
        toolNames: params.toolNames,
        isError: params.isError,
        isCorrection: params.isCorrection,
        roles: params.roles as MessageRole[] | undefined,
        textPattern: params.textPattern,
        timeRange: params.timeRange,
        turnRange: params.turnRange,
      }

      let results: readonly TurnReference[]
      let total: number

      if (params.sessionId) {
        const queryResult = await querySingleSession(
          params.sessionId, db, claudeDir, filters, limit, offset,
        )
        results = queryResult.results
        total = queryResult.total
      } else {
        // Cross-session: ensure turn_events are indexed
        await ensureTurnEventsIndexed(params.projectId!, db, claudeDir)

        const queryResult = queryCrossSession(
          params.projectId!, db, filters, limit, offset,
        )
        results = queryResult.results
        total = queryResult.total
      }

      const hasMore = offset + results.length < total
      const nextCursor = hasMore ? String(offset + results.length) : undefined

      const meta = formatter.formatMeta(freshness)
      const response = formatter.format(
        { results, total },
        meta,
        hasMore ? { cursor: nextCursor!, hasMore: true, totalEstimate: total } : undefined,
      )

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      }
    }
  )
}
