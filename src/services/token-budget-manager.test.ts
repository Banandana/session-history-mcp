import { describe, it, expect } from 'vitest'
import { TokenBudgetManager } from './token-budget-manager'
import type { NormalizedMessage, ContentBlock } from '../types'

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

  describe('filterByWindow', () => {
    const messages = Array.from({ length: 15 }, (_, i) =>
      makeTextMessage(`msg-${i}`, `message ${i}`, { timestamp: `2026-01-01T00:${String(i).padStart(2, '0')}:00Z` })
    )

    it('start window returns first N messages', () => {
      const result = manager.filterByWindow(messages, 'start')
      expect(result).toHaveLength(10)
      expect(result[0].id).toBe('msg-0')
      expect(result[9].id).toBe('msg-9')
    })

    it('end window returns last N messages', () => {
      const result = manager.filterByWindow(messages, 'end')
      expect(result).toHaveLength(10)
      expect(result[0].id).toBe('msg-5')
      expect(result[9].id).toBe('msg-14')
    })

    it('errors window returns error messages with context', () => {
      const msgs = [
        makeTextMessage('msg-0', 'before error', { timestamp: '2026-01-01T00:00:00Z' }),
        makeTextMessage('msg-1', 'error occurred', { timestamp: '2026-01-01T00:01:00Z', isError: true }),
        makeTextMessage('msg-2', 'after error', { timestamp: '2026-01-01T00:02:00Z' }),
        makeTextMessage('msg-3', 'normal message', { timestamp: '2026-01-01T00:03:00Z' }),
        makeTextMessage('msg-4', 'another normal', { timestamp: '2026-01-01T00:04:00Z' }),
      ]

      const result = manager.filterByWindow(msgs, 'errors')
      const ids = result.map(m => m.id)

      expect(ids).toContain('msg-0')  // before error
      expect(ids).toContain('msg-1')  // error
      expect(ids).toContain('msg-2')  // after error
      expect(ids).not.toContain('msg-3')
      expect(ids).not.toContain('msg-4')
    })

    it('corrections window returns correction messages with corrected assistant turn', () => {
      const msgs = [
        makeTextMessage('msg-0', 'user question', { timestamp: '2026-01-01T00:00:00Z', role: 'user' }),
        makeTextMessage('msg-1', 'wrong answer', { timestamp: '2026-01-01T00:01:00Z', role: 'assistant' }),
        makeTextMessage('msg-2', 'that was wrong', { timestamp: '2026-01-01T00:02:00Z', role: 'user', isCorrection: true }),
        makeTextMessage('msg-3', 'corrected answer', { timestamp: '2026-01-01T00:03:00Z', role: 'assistant' }),
      ]

      const result = manager.filterByWindow(msgs, 'corrections')
      const ids = result.map(m => m.id)

      expect(ids).toContain('msg-2')  // correction
      expect(ids).toContain('msg-1')  // the assistant turn being corrected
      expect(ids).not.toContain('msg-0')
      expect(ids).not.toContain('msg-3')
    })

    it('returns empty array for errors window with no errors', () => {
      const msgs = [
        makeTextMessage('msg-0', 'normal'),
        makeTextMessage('msg-1', 'normal too'),
      ]
      const result = manager.filterByWindow(msgs, 'errors')
      expect(result).toHaveLength(0)
    })

    it('returns empty array for corrections window with no corrections', () => {
      const msgs = [
        makeTextMessage('msg-0', 'normal'),
        makeTextMessage('msg-1', 'normal too'),
      ]
      const result = manager.filterByWindow(msgs, 'corrections')
      expect(result).toHaveLength(0)
    })
  })

  describe('error window content cleaning', () => {
    it('strips thinking blocks from error window messages', () => {
      const msgs = [
        makeMessage({
          id: 'msg-0',
          role: 'assistant',
          timestamp: '2026-01-01T00:00:00Z',
          contentBlocks: [
            { type: 'thinking', thinking: 'base64signaturedatahere==' },
            { type: 'text', text: 'I will run a command' },
            { type: 'tool_use', id: 'tu-1', name: 'bash', input: { command: 'ls' } },
          ],
        }),
        makeMessage({
          id: 'msg-1',
          role: 'user',
          timestamp: '2026-01-01T00:01:00Z',
          isError: true,
          contentBlocks: [
            { type: 'tool_result', tool_use_id: 'tu-1', content: 'command failed' },
          ],
        }),
        makeMessage({
          id: 'msg-2',
          role: 'assistant',
          timestamp: '2026-01-01T00:02:00Z',
          contentBlocks: [
            { type: 'text', text: 'Let me fix that' },
          ],
        }),
      ]

      const result = manager.filterByWindow(msgs, 'errors')
      const allBlocks = result.flatMap(m => m.contentBlocks)
      const thinkingBlocks = allBlocks.filter(b => b.type === 'thinking')

      expect(thinkingBlocks).toHaveLength(0)
    })

    it('collapses tool_use input to summary in error window', () => {
      const msgs = [
        makeMessage({
          id: 'msg-0',
          role: 'assistant',
          timestamp: '2026-01-01T00:00:00Z',
          contentBlocks: [
            {
              type: 'tool_use',
              id: 'tu-1',
              name: 'bash',
              input: { command: 'echo hello', cwd: '/some/path', env: { KEY: 'VALUE' } },
            },
          ],
        }),
        makeMessage({
          id: 'msg-1',
          role: 'user',
          timestamp: '2026-01-01T00:01:00Z',
          isError: true,
          contentBlocks: [
            { type: 'tool_result', tool_use_id: 'tu-1', content: 'error output' },
          ],
        }),
      ]

      const result = manager.filterByWindow(msgs, 'errors')
      const toolUseBlocks = result.flatMap(m => m.contentBlocks).filter(b => b.type === 'tool_use')

      expect(toolUseBlocks).toHaveLength(1)
      // input should be collapsed to a string summary, not the original object
      expect(typeof toolUseBlocks[0].input).toBe('string')
    })

    it('extracts stderr from tool_result in error window', () => {
      const msgs = [
        makeMessage({
          id: 'msg-0',
          role: 'assistant',
          timestamp: '2026-01-01T00:00:00Z',
          contentBlocks: [
            { type: 'tool_use', id: 'tu-1', name: 'bash', input: { command: 'make' } },
          ],
        }),
        makeMessage({
          id: 'msg-1',
          role: 'user',
          timestamp: '2026-01-01T00:01:00Z',
          isError: true,
          contentBlocks: [
            {
              type: 'tool_result',
              tool_use_id: 'tu-1',
              content: { stdout: '', stderr: 'make: *** No rule to make target' },
            },
          ],
        }),
      ]

      const result = manager.filterByWindow(msgs, 'errors')
      const toolResultBlocks = result.flatMap(m => m.contentBlocks).filter(b => b.type === 'tool_result')

      expect(toolResultBlocks).toHaveLength(1)
      expect(toolResultBlocks[0].content).toBe('make: *** No rule to make target')
    })
  })
})
