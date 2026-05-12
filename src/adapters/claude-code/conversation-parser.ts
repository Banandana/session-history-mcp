import { basename } from 'node:path'
import { streamJsonlLines } from '../../infrastructure/file-system'
import type { NormalizedMessage, ContentBlock, TokenUsage, MessageRole } from '../../types'

/** JSONL line types that should be skipped entirely. */
const SKIP_TYPES = new Set(['file-history-snapshot', 'queue-operation', 'progress'])

interface RawJsonlLine {
  type?: string
  uuid?: string
  parentUuid?: string | null
  cwd?: string
  gitBranch?: string
  entrypoint?: string
  message?: {
    id?: string
    role?: string
    model?: string
    content?: unknown
    stop_reason?: string | null
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_creation_input_tokens?: number
      cache_read_input_tokens?: number
    }
  }
  requestId?: string
  timestamp?: string
  sessionId?: string
}

/** Pending assistant turn being assembled from multiple content-block lines. */
interface PendingAssistant {
  requestId: string
  messageId: string
  parentUuid: string | null
  firstUuid: string
  model?: string
  timestamp: string
  sessionId: string
  contentBlocks: ContentBlock[]
  tokenUsage: TokenUsage
  stopReason: string | null
  toolNames: string[]
  hasThinking: boolean
  cwd?: string
  gitBranch?: string
  entrypoint?: string
}

function extractSessionId(sessionPath: string): string {
  const filename = basename(sessionPath, '.jsonl')
  return filename
}

function mergeTokenUsage(existing: TokenUsage, incoming: RawJsonlLine['message']): TokenUsage {
  const usage = incoming?.usage
  if (!usage) return existing
  // Take the maximum of each field — the last chunk typically has the final totals,
  // but we use max to be safe.
  return {
    input_tokens: Math.max(existing.input_tokens, usage.input_tokens ?? 0),
    output_tokens: Math.max(existing.output_tokens, usage.output_tokens ?? 0),
    cache_creation_input_tokens: Math.max(
      existing.cache_creation_input_tokens ?? 0,
      usage.cache_creation_input_tokens ?? 0
    ) || undefined,
    cache_read_input_tokens: Math.max(
      existing.cache_read_input_tokens ?? 0,
      usage.cache_read_input_tokens ?? 0
    ) || undefined,
  }
}

function extractContentBlocks(content: unknown): ContentBlock[] {
  if (!content) return []
  if (Array.isArray(content)) {
    return content.map(normalizeContentBlock)
  }
  // Single string content → text block
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }]
  }
  return []
}

function normalizeContentBlock(raw: Record<string, unknown>): ContentBlock {
  const block: Record<string, unknown> = { type: raw['type'] }
  if (raw['type'] === 'text' && typeof raw['text'] === 'string') {
    block['text'] = raw['text']
  }
  if (raw['type'] === 'thinking') {
    block['thinking'] = typeof raw['thinking'] === 'string' ? raw['thinking'] : ''
    if (raw['signature']) block['signature'] = raw['signature']
  }
  if (raw['type'] === 'tool_use') {
    block['id'] = raw['id']
    block['name'] = raw['name']
    block['input'] = raw['input']
  }
  if (raw['type'] === 'tool_result') {
    block['tool_use_id'] = raw['tool_use_id']
    block['content'] = raw['content']
    if (raw['is_error']) block['content'] = raw['content']
  }
  return block as unknown as ContentBlock
}

const NEGATION_STARTS = /^(no[,.\s!]|stop[,.\s!]|don'?t\s|not that|wrong|nope|that'?s not|i said|i told you|should have|you should have)/
const CORRECTION_KEYWORDS = /\b(wrong|don'?t|not that|i said|i told you|should have|you should have|instead of|actually no|stop being|stop doing|stop adding)\b/
const ALL_CAPS_RE = /[A-Z]{4,}/

/** Heuristic: is this user text message a correction of the preceding assistant turn? */
function detectCorrection(contentBlocks: readonly ContentBlock[]): boolean {
  if (contentBlocks.length === 0) return false
  const firstBlock = contentBlocks[0]
  if (firstBlock.type !== 'text' || !firstBlock.text) return false

  const text = firstBlock.text.trim().toLowerCase()
  if (text.length === 0) return false

  // Pattern 1: Starts with negation/redirection
  if (NEGATION_STARTS.test(text)) return true

  // Pattern 2: Correction keywords anywhere in message
  if (CORRECTION_KEYWORDS.test(text)) return true

  // Pattern 3: ALL CAPS messages with 4+ consecutive caps (anger/emphasis)
  const original = firstBlock.text!.trim()
  if (original === original.toUpperCase() && ALL_CAPS_RE.test(original)) {
    return true
  }

  return false
}

function detectToolResultError(line: RawJsonlLine): boolean {
  const content = line.message?.content
  if (!Array.isArray(content)) return false
  for (const block of content) {
    if (block.type === 'tool_result') {
      // Explicit is_error flag
      if (block.is_error === true) return true
      // Check toolUseResult-style content
      const result = block.content
      if (typeof result === 'string' && /error/i.test(result)) return true
      if (result && typeof result === 'object' && !Array.isArray(result)) {
        if ((result as Record<string, unknown>)['stderr'] &&
            String((result as Record<string, unknown>)['stderr']).trim().length > 0) {
          return true
        }
      }
    }
  }
  return false
}

function detectToolUseResultError(line: RawJsonlLine): boolean {
  // Some lines have a top-level toolUseResult field
  const raw = line as Record<string, unknown>
  const toolUseResult = raw['toolUseResult']
  if (toolUseResult === undefined) return false
  if (typeof toolUseResult === 'string') return /error/i.test(toolUseResult)
  if (toolUseResult && typeof toolUseResult === 'object') {
    const obj = toolUseResult as Record<string, unknown>
    if (obj['stderr'] && String(obj['stderr']).trim().length > 0) return true
  }
  return false
}

function finalizePending(pending: PendingAssistant): NormalizedMessage {
  const toolNames = pending.toolNames.length > 0 ? pending.toolNames : undefined
  return {
    id: pending.messageId,
    sessionId: pending.sessionId,
    role: 'assistant' as MessageRole,
    timestamp: pending.timestamp,
    contentBlocks: pending.contentBlocks,
    model: pending.model,
    tokenUsage: pending.tokenUsage,
    toolNames,
    isError: false,
    isCorrection: false,
    hasThinking: pending.hasThinking,
    requestId: pending.requestId,
    parentUuid: pending.parentUuid,
    uuid: pending.firstUuid,
    cwd: pending.cwd,
    gitBranch: pending.gitBranch,
    entrypoint: pending.entrypoint,
  }
}

export class ConversationParser {
  async *parseSession(
    sessionPath: string,
    startOffset: number = 0,
  ): AsyncIterable<NormalizedMessage> {
    const sessionId = extractSessionId(sessionPath)
    let pending: PendingAssistant | null = null
    const toolUseIdToName = new Map<string, string>()

    for await (const { line } of streamJsonlLines(sessionPath, startOffset)) {
      let parsed: RawJsonlLine
      try {
        parsed = JSON.parse(line) as RawJsonlLine
      } catch {
        continue // skip malformed lines
      }

      const lineType = parsed.type

      // Skip non-conversation lines
      if (lineType && SKIP_TYPES.has(lineType)) continue

      if (lineType === 'user') {
        // Flush any pending assistant message first
        if (pending) {
          yield finalizePending(pending)
          for (const block of pending.contentBlocks) {
            if (block.type === 'tool_use' && block.id && block.name) {
              toolUseIdToName.set(block.id, block.name)
            }
          }
          pending = null
        }

        const content = parsed.message?.content
        const blocks = extractContentBlocks(content)
        const isToolResult = Array.isArray(content)
        const isError = isToolResult ? detectToolResultError(parsed) : false

        const resolvedToolNames: string[] = []
        if (isToolResult) {
          for (const block of blocks) {
            if (block.type === 'tool_result' && block.tool_use_id) {
              const name = toolUseIdToName.get(block.tool_use_id)
              if (name) resolvedToolNames.push(name)
            }
          }
        }

        yield {
          id: parsed.uuid ?? `user-${Date.now()}`,
          sessionId,
          role: 'user' as MessageRole,
          timestamp: parsed.timestamp ?? new Date().toISOString(),
          contentBlocks: blocks,
          isError,
          isCorrection: isToolResult ? false : detectCorrection(blocks),
          hasThinking: false,
          toolNames: resolvedToolNames.length > 0 ? resolvedToolNames : undefined,
          parentUuid: parsed.parentUuid ?? null,
          uuid: parsed.uuid ?? `user-${Date.now()}`,
          cwd: parsed.cwd,
          gitBranch: parsed.gitBranch,
          entrypoint: parsed.entrypoint,
        }
        continue
      }

      if (lineType === 'assistant') {
        const requestId = parsed.requestId ?? ''
        const messageId = parsed.message?.id ?? parsed.uuid ?? ''

        // Extract content blocks from this chunk
        const chunkBlocks = extractContentBlocks(parsed.message?.content)
        const chunkToolNames = chunkBlocks
          .filter(b => b.type === 'tool_use' && b.name)
          .map(b => b.name!)

        const chunkHasThinking = chunkBlocks.some(b => b.type === 'thinking')

        if (pending && pending.requestId === requestId) {
          // Same assistant turn — append blocks
          pending.contentBlocks.push(...chunkBlocks)
          pending.toolNames.push(...chunkToolNames)
          pending.tokenUsage = mergeTokenUsage(pending.tokenUsage, parsed.message)
          pending.stopReason = parsed.message?.stop_reason ?? pending.stopReason
          if (chunkHasThinking) pending.hasThinking = true
        } else {
          // Different requestId — flush previous
          if (pending) {
            yield finalizePending(pending)
            for (const block of pending.contentBlocks) {
              if (block.type === 'tool_use' && block.id && block.name) {
                toolUseIdToName.set(block.id, block.name)
              }
            }
          }
          pending = {
            requestId,
            messageId,
            parentUuid: parsed.parentUuid ?? null,
            firstUuid: parsed.uuid ?? messageId,
            model: parsed.message?.model,
            timestamp: parsed.timestamp ?? new Date().toISOString(),
            sessionId,
            contentBlocks: [...chunkBlocks],
            tokenUsage: {
              input_tokens: parsed.message?.usage?.input_tokens ?? 0,
              output_tokens: parsed.message?.usage?.output_tokens ?? 0,
              cache_creation_input_tokens: parsed.message?.usage?.cache_creation_input_tokens,
              cache_read_input_tokens: parsed.message?.usage?.cache_read_input_tokens,
            },
            stopReason: parsed.message?.stop_reason ?? null,
            toolNames: chunkToolNames,
            hasThinking: chunkHasThinking,
            cwd: parsed.cwd,
            gitBranch: parsed.gitBranch,
            entrypoint: parsed.entrypoint,
          }
        }
        continue
      }

      // Unknown type — skip
    }

    // Flush final pending assistant message
    if (pending) {
      yield finalizePending(pending)
      for (const block of pending.contentBlocks) {
        if (block.type === 'tool_use' && block.id && block.name) {
          toolUseIdToName.set(block.id, block.name)
        }
      }
    }
  }
}
