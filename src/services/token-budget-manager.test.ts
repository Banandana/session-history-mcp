import { describe, it, expect } from 'vitest'
import { TokenBudgetManager } from './token-budget-manager'
import type { NormalizedMessage } from '../types'

function makeMessage(
  overrides: Partial<NormalizedMessage> & { id: string }
): NormalizedMessage {
  return {
    id: overrides.id,
    sessionId: 'session-1',
    role: overrides.role ?? 'user',
    timestamp: overrides.timestamp ?? '2026-01-01T00:00:00Z',
    contentBlocks: overrides.contentBlocks ?? [{ type: 'text', text: 'hello' }],
    isError: overrides.isError ?? false,
    isCorrection: overrides.isCorrection ?? false,
    hasThinking: false,
    uuid: overrides.id,
    ...overrides,
  }
}

function makeTextMessage(id: string, text: string, overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return makeMessage({ id, contentBlocks: [{ type: 'text', text }], ...overrides })
}

describe('TokenBudgetManager', () => {
  const manager = new TokenBudgetManager()

  describe('fitWithinBudget', () => {
    it('returns all messages when content is within budget', () => {
      const messages = [
        makeTextMessage('msg-1', 'hello'),
        makeTextMessage('msg-2', 'world'),
      ]

      const result = manager.fitWithinBudget(messages, 1000)

      expect(result.truncated).toBe(false)
      expect(result.messages).toHaveLength(2)
      expect(result.totalMessages).toBe(2)
      expect(result.includedMessages).toBe(2)
    })

    it('truncates messages when content exceeds budget', () => {
      // Each message has ~400 chars of text = ~100 tokens
      const longText = 'a'.repeat(400)
      const messages = Array.from({ length: 10 }, (_, i) =>
        makeTextMessage(`msg-${i}`, longText, { timestamp: `2026-01-01T00:0${i}:00Z` })
      )

      // Budget of 300 tokens = room for ~3 messages
      const result = manager.fitWithinBudget(messages, 300)

      expect(result.truncated).toBe(true)
      expect(result.totalMessages).toBe(10)
      expect(result.includedMessages).toBeLessThan(10)
    })

    it('preserves first and last messages when truncating', () => {
      const longText = 'a'.repeat(400)
      const messages = Array.from({ length: 10 }, (_, i) =>
        makeTextMessage(`msg-${i}`, longText, { timestamp: `2026-01-01T00:0${i}:00Z` })
      )

      const result = manager.fitWithinBudget(messages, 300)

      const ids = result.messages.map(m => m.id)
      expect(ids).toContain('msg-0')   // first
      expect(ids).toContain('msg-9')   // last
    })

    it('preserves error messages when truncating', () => {
      const longText = 'a'.repeat(400)
      const messages = [
        makeTextMessage('msg-0', longText, { timestamp: '2026-01-01T00:00:00Z' }),
        makeTextMessage('msg-1', longText, { timestamp: '2026-01-01T00:01:00Z' }),
        makeTextMessage('msg-2', longText, { timestamp: '2026-01-01T00:02:00Z', isError: true }),
        makeTextMessage('msg-3', longText, { timestamp: '2026-01-01T00:03:00Z' }),
        makeTextMessage('msg-4', longText, { timestamp: '2026-01-01T00:04:00Z' }),
        makeTextMessage('msg-5', longText, { timestamp: '2026-01-01T00:05:00Z' }),
        makeTextMessage('msg-6', longText, { timestamp: '2026-01-01T00:06:00Z' }),
        makeTextMessage('msg-7', longText, { timestamp: '2026-01-01T00:07:00Z' }),
        makeTextMessage('msg-8', longText, { timestamp: '2026-01-01T00:08:00Z' }),
        makeTextMessage('msg-9', longText, { timestamp: '2026-01-01T00:09:00Z' }),
      ]

      const result = manager.fitWithinBudget(messages, 400)

      const ids = result.messages.map(m => m.id)
      expect(ids).toContain('msg-2')  // error message
    })

    it('returns messages in original timestamp order after truncation', () => {
      const longText = 'a'.repeat(400)
      const messages = Array.from({ length: 8 }, (_, i) =>
        makeTextMessage(`msg-${i}`, longText, { timestamp: `2026-01-01T00:0${i}:00Z` })
      )

      const result = manager.fitWithinBudget(messages, 300)

      const timestamps = result.messages.map(m => m.timestamp)
      const sorted = [...timestamps].sort()
      expect(timestamps).toEqual(sorted)
    })

    it('handles empty messages array', () => {
      const result = manager.fitWithinBudget([], 1000)
      expect(result.messages).toHaveLength(0)
      expect(result.truncated).toBe(false)
      expect(result.totalMessages).toBe(0)
      expect(result.includedMessages).toBe(0)
    })
  })

  describe('estimateTokens', () => {
    it('estimates tokens at ~4 chars per token for text blocks', () => {
      const msg = makeTextMessage('msg-1', 'a'.repeat(400))
      const tokens = manager.estimateTokens(msg)
      expect(tokens).toBe(100)
    })

    it('estimates tokens for tool_use blocks', () => {
      const msg = makeMessage({
        id: 'msg-1',
        contentBlocks: [{
          type: 'tool_use',
          name: 'bash',
          input: { command: 'echo hello' },
        }],
      })
      const tokens = manager.estimateTokens(msg)
      // 'bash' (4) + '{"command":"echo hello"}' (24) = 28 chars / 4 = 7
      expect(tokens).toBeGreaterThan(0)
    })

    it('limits tool_result content to 500 chars', () => {
      const longContent = 'x'.repeat(2000)
      const msg = makeMessage({
        id: 'msg-1',
        contentBlocks: [{
          type: 'tool_result',
          content: longContent,
        }],
      })
      const tokens = manager.estimateTokens(msg)
      // Should be capped at 500 chars = 125 tokens
      expect(tokens).toBe(125)
    })

    it('returns 0 for empty message', () => {
      const msg = makeMessage({ id: 'msg-1', contentBlocks: [] })
      const tokens = manager.estimateTokens(msg)
      expect(tokens).toBe(0)
    })
  })

})
