import type { NormalizedMessage, ContentBlock } from '../types'

export interface TruncationResult {
  readonly messages: readonly NormalizedMessage[]
  readonly truncated: boolean
  readonly totalMessages: number
  readonly includedMessages: number
}

export class TokenBudgetManager {
  private readonly charsPerToken = 4

  fitWithinBudget(
    messages: readonly NormalizedMessage[],
    maxTokens: number
  ): TruncationResult {
    const totalMessages = messages.length

    // Estimate total tokens
    const totalTokens = messages.reduce((sum, msg) => sum + this.estimateTokens(msg), 0)

    // Within budget — return all
    if (totalTokens <= maxTokens) {
      return {
        messages,
        truncated: false,
        totalMessages,
        includedMessages: totalMessages,
      }
    }

    // Score each message by priority
    const scored = messages.map((msg, index) => {
      let priority: number

      const hasThinkingOnly =
        msg.contentBlocks.length > 0 &&
        msg.contentBlocks.every(b => b.type === 'thinking')

      if (index === 0) {
        priority = 100
      } else if (index === totalMessages - 1) {
        priority = 90
      } else if (msg.isError) {
        priority = 80
      } else if (msg.isCorrection) {
        priority = 70
      } else if (msg.toolNames && msg.toolNames.length > 0) {
        priority = 30
      } else if (hasThinkingOnly) {
        priority = 0
      } else {
        priority = 10
      }

      return { msg, priority, index }
    })

    // Sort by priority descending, then by index ascending (stable tiebreak)
    scored.sort((a, b) => b.priority - a.priority || a.index - b.index)

    // Greedily include until budget exhausted
    let remaining = maxTokens
    const included: Array<{ msg: NormalizedMessage; index: number }> = []

    for (const item of scored) {
      const tokens = this.estimateTokens(item.msg)
      if (tokens <= remaining) {
        remaining -= tokens
        included.push({ msg: item.msg, index: item.index })
      }
    }

    // Re-sort by original order (index)
    included.sort((a, b) => a.index - b.index)

    return {
      messages: included.map(item => item.msg),
      truncated: true,
      totalMessages,
      includedMessages: included.length,
    }
  }

  estimateTokens(message: NormalizedMessage): number {
    let charCount = 0

    for (const block of message.contentBlocks) {
      if (block.type === 'text' && block.text) {
        charCount += block.text.length
      } else if (block.type === 'thinking' && block.thinking) {
        charCount += block.thinking.length
      } else if (block.type === 'tool_use') {
        if (block.name) charCount += block.name.length
        if (block.input !== undefined) charCount += JSON.stringify(block.input).length
      } else if (block.type === 'tool_result') {
        const content = block.content
        if (typeof content === 'string') {
          charCount += Math.min(content.length, 500)
        } else if (content !== undefined) {
          charCount += Math.min(JSON.stringify(content).length, 500)
        }
      }
    }

    return Math.ceil(charCount / this.charsPerToken)
  }

  /** Clean content blocks for error/correction windows — strip noise, keep signal. */
  private cleanContentBlocks(blocks: readonly ContentBlock[]): ContentBlock[] {
    const cleaned: ContentBlock[] = []
    for (const block of blocks) {
      // Strip thinking blocks entirely
      if (block.type === 'thinking') continue

      // Collapse tool_use input to key params summary
      if (block.type === 'tool_use') {
        const inputSummary = block.input
          ? Object.entries(block.input as Record<string, unknown>)
              .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
              .join(', ')
              .slice(0, 200)
          : undefined
        cleaned.push({ type: 'tool_use', id: block.id, name: block.name, input: inputSummary as unknown })
        continue
      }

      // Extract error message from tool_result blocks
      if (block.type === 'tool_result') {
        let errorText: string | undefined
        if (typeof block.content === 'string') {
          errorText = block.content
        } else if (block.content && typeof block.content === 'object') {
          const obj = block.content as Record<string, unknown>
          if (obj.stderr && String(obj.stderr).trim()) {
            errorText = String(obj.stderr).trim()
          } else {
            errorText = JSON.stringify(block.content).slice(0, 300)
          }
        }
        cleaned.push({ type: 'tool_result', tool_use_id: block.tool_use_id, content: errorText })
        continue
      }

      // Text blocks pass through unchanged
      cleaned.push(block)
    }
    return cleaned
  }

  filterByWindow(
    messages: readonly NormalizedMessage[],
    window: 'start' | 'end' | 'errors' | 'corrections'
  ): readonly NormalizedMessage[] {
    const N = 10

    if (window === 'start') {
      return messages.slice(0, N)
    }

    if (window === 'end') {
      return messages.slice(-N)
    }

    if (window === 'errors') {
      const result: NormalizedMessage[] = []
      const addedIds = new Set<string>()

      for (let i = 0; i < messages.length; i++) {
        if (messages[i].isError) {
          // Include 1 message before
          if (i > 0 && !addedIds.has(messages[i - 1].id)) {
            result.push(messages[i - 1])
            addedIds.add(messages[i - 1].id)
          }
          // Include the error message
          if (!addedIds.has(messages[i].id)) {
            result.push(messages[i])
            addedIds.add(messages[i].id)
          }
          // Include 1 message after
          if (i < messages.length - 1 && !addedIds.has(messages[i + 1].id)) {
            result.push(messages[i + 1])
            addedIds.add(messages[i + 1].id)
          }
        }
      }

      return result.map(msg => ({
        ...msg,
        contentBlocks: this.cleanContentBlocks(msg.contentBlocks),
      }))
    }

    if (window === 'corrections') {
      const result: NormalizedMessage[] = []
      const addedIds = new Set<string>()

      for (let i = 0; i < messages.length; i++) {
        if (messages[i].isCorrection) {
          // Include the correction message
          if (!addedIds.has(messages[i].id)) {
            result.push(messages[i])
            addedIds.add(messages[i].id)
          }

          // Include the preceding assistant turn it corrected
          // Walk backwards to find the most recent assistant message
          for (let j = i - 1; j >= 0; j--) {
            if (messages[j].role === 'assistant' && !addedIds.has(messages[j].id)) {
              result.push(messages[j])
              addedIds.add(messages[j].id)
              break
            }
          }
        }
      }

      // Re-sort by timestamp to maintain order
      result.sort((a, b) => a.timestamp.localeCompare(b.timestamp))

      return result.map(msg => ({
        ...msg,
        contentBlocks: this.cleanContentBlocks(msg.contentBlocks),
      }))
    }

    return messages
  }
}
