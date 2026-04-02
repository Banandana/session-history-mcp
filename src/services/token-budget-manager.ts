import type { NormalizedMessage } from '../types'

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

}
