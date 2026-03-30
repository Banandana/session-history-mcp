import { basename } from 'node:path'

import type { NormalizedMessage, ContentBlock, Focus } from '../types'

export interface DistillOptions {
  readonly n?: number
  readonly focus?: Focus
}

export interface DistilledMessage {
  readonly role: 'user' | 'assistant' | 'action'
  readonly text: string
}

export interface DistilledConversation {
  readonly messages: readonly DistilledMessage[]
  readonly estimatedTokens: number
}

const MAX_TEXT_LENGTH = 500

function extractToolParams(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return name
  const params = input as Record<string, unknown>
  if ('file_path' in params) return `${name}: ${basename(String(params.file_path))}`
  if ('path' in params) return `${name}: ${params.path}`
  if ('pattern' in params) return `${name}: ${params.pattern}`
  if ('command' in params) return `${name}: ${String(params.command).slice(0, 60)}`
  const keys = ['ref', 'value', 'footprint', 'component', 'netName', 'label']
  const extracted = keys.filter(k => k in params).map(k => `${k}=${params[k]}`).join(', ')
  return extracted ? `${name}: ${extracted}` : name
}

function truncate(text: string, maxLength = MAX_TEXT_LENGTH): string {
  return text.length <= maxLength ? text : text.slice(0, maxLength)
}

function isToolResultMessage(blocks: readonly ContentBlock[]): boolean {
  return blocks.length > 0 && blocks.every(b => b.type === 'tool_result')
}

function distillMessage(message: NormalizedMessage, focus: Focus): readonly DistilledMessage[] {
  if (message.role === 'system') return []

  const { contentBlocks } = message

  if (contentBlocks.length === 0) return []

  // Drop messages where all blocks are tool_result, unless focus=tools and it's an error
  if (isToolResultMessage(contentBlocks) && !(focus === 'tools' && message.isError)) return []

  const result: DistilledMessage[] = []

  // For user/assistant messages: process blocks into text and action segments
  // Consecutive tool_use blocks get merged into a single action line
  let toolNames: string[] = []

  function flushTools(): void {
    if (toolNames.length > 0) {
      result.push({ role: 'action', text: `[${toolNames.join(', ')}]` })
      toolNames = []
    }
  }

  let textAccumulator = ''

  function flushText(): void {
    if (textAccumulator.length > 0) {
      const role: 'user' | 'assistant' = message.role === 'user' ? 'user' : 'assistant'
      const maxLength = focus === 'files' ? 200 : MAX_TEXT_LENGTH
      result.push({ role, text: truncate(textAccumulator, maxLength) })
      textAccumulator = ''
    }
  }

  for (const block of contentBlocks) {
    if (block.type === 'thinking') {
      // Drop thinking blocks; flush any pending tools before moving on
      flushTools()
      continue
    }

    if (block.type === 'tool_result') {
      flushTools()
      // In focus=tools mode, keep error tool results as an action line
      if (focus === 'tools' && message.isError) {
        const errorText = typeof block.content === 'string'
          ? block.content.slice(0, 200)
          : 'tool error'
        result.push({ role: 'action', text: `[error: ${errorText}]` })
      }
      continue
    }

    if (block.type === 'text') {
      // Flush accumulated tool names before text
      flushTools()
      textAccumulator += block.text ?? ''
      continue
    }

    if (block.type === 'tool_use') {
      if (focus === 'decisions') continue
      // Flush any accumulated text before tool_use
      flushText()
      const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'Glob', 'Grep'])
      if (focus === 'files' && FILE_TOOLS.has(block.name ?? '')) {
        toolNames.push(extractToolParams(block.name!, block.input))
      } else if (focus === 'tools') {
        toolNames.push(extractToolParams(block.name ?? 'unknown', block.input))
      } else {
        toolNames.push(block.name ?? 'unknown')
      }
      continue
    }
  }

  // Flush remaining
  flushText()
  flushTools()

  return result
}

function distillWithErrorFocus(messages: readonly NormalizedMessage[]): readonly DistilledMessage[] {
  const keep = new Set<number>()
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].isError || messages[i].isCorrection) {
      if (i > 0) keep.add(i - 1)
      keep.add(i)
      if (i < messages.length - 1) keep.add(i + 1)
    }
  }

  const result: DistilledMessage[] = []
  let gapCount = 0

  for (let i = 0; i < messages.length; i++) {
    if (keep.has(i)) {
      if (gapCount > 0) {
        result.push({ role: 'action', text: `[... ${gapCount} messages ...]` })
        gapCount = 0
      }
      result.push(...distillMessage(messages[i], 'general'))
    } else {
      gapCount++
    }
  }
  if (gapCount > 0) {
    result.push({ role: 'action', text: `[... ${gapCount} messages ...]` })
  }

  return result
}

function selectBookends(
  messages: readonly NormalizedMessage[],
  n: number,
): readonly NormalizedMessage[] {
  if (messages.length <= n * 2) return messages

  const firstN = messages.slice(0, n)
  const lastN = messages.slice(messages.length - n)

  // Deduplicate by id while preserving order
  const seen = new Set<string>()
  const merged: NormalizedMessage[] = []

  for (const msg of [...firstN, ...lastN]) {
    if (!seen.has(msg.id)) {
      seen.add(msg.id)
      merged.push(msg)
    }
  }

  return merged
}

export function distillConversation(
  messages: readonly NormalizedMessage[],
  options?: DistillOptions,
): DistilledConversation {
  const n = options?.n ?? 10
  const focus = options?.focus ?? 'general'

  // errors focus bypasses bookends — operates on full message array
  // to find errors wherever they are in the conversation
  if (focus === 'errors') {
    const distilled = distillWithErrorFocus(messages)
    const estimatedTokens = distilled.reduce((sum, m) => sum + Math.floor(m.text.length / 4), 0)
    return { messages: distilled, estimatedTokens }
  }

  const selected = selectBookends(messages, n)
  const distilled: DistilledMessage[] = []

  for (const message of selected) {
    const parts = distillMessage(message, focus)
    distilled.push(...parts)
  }

  const estimatedTokens = distilled.reduce(
    (sum, msg) => sum + Math.floor(msg.text.length / 4),
    0,
  )

  return {
    messages: distilled,
    estimatedTokens,
  }
}
