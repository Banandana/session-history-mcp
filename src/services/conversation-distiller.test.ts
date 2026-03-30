import { describe, it, expect } from 'vitest'
import { distillConversation } from './conversation-distiller'
import type { NormalizedMessage } from '../types'

function makeMessage(overrides: Partial<NormalizedMessage> & { id: string }): NormalizedMessage {
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

describe('distillConversation', () => {
  describe('user messages', () => {
    it('keeps user text verbatim', () => {
      const messages = [
        makeMessage({
          id: 'msg-1',
          role: 'user',
          contentBlocks: [{ type: 'text', text: 'Hello, can you help me?' }],
        }),
      ]

      const result = distillConversation(messages)

      expect(result.messages).toHaveLength(1)
      expect(result.messages[0].role).toBe('user')
      expect(result.messages[0].text).toBe('Hello, can you help me?')
    })

    it('truncates user text to 500 chars', () => {
      const longText = 'a'.repeat(600)
      const messages = [
        makeMessage({
          id: 'msg-1',
          role: 'user',
          contentBlocks: [{ type: 'text', text: longText }],
        }),
      ]

      const result = distillConversation(messages)

      expect(result.messages[0].text.length).toBe(500)
    })

    it('concatenates multiple text blocks in a user message', () => {
      const messages = [
        makeMessage({
          id: 'msg-1',
          role: 'user',
          contentBlocks: [
            { type: 'text', text: 'First part.' },
            { type: 'text', text: ' Second part.' },
          ],
        }),
      ]

      const result = distillConversation(messages)

      expect(result.messages[0].text).toBe('First part. Second part.')
    })
  })

  describe('assistant messages', () => {
    it('keeps assistant text blocks', () => {
      const messages = [
        makeMessage({
          id: 'msg-1',
          role: 'assistant',
          contentBlocks: [{ type: 'text', text: 'Sure, I can help!' }],
        }),
      ]

      const result = distillConversation(messages)

      expect(result.messages).toHaveLength(1)
      expect(result.messages[0].role).toBe('assistant')
      expect(result.messages[0].text).toBe('Sure, I can help!')
    })

    it('truncates assistant text to 500 chars', () => {
      const longText = 'b'.repeat(600)
      const messages = [
        makeMessage({
          id: 'msg-1',
          role: 'assistant',
          contentBlocks: [{ type: 'text', text: longText }],
        }),
      ]

      const result = distillConversation(messages)

      expect(result.messages[0].text.length).toBe(500)
    })

    it('drops thinking blocks from assistant messages', () => {
      const messages = [
        makeMessage({
          id: 'msg-1',
          role: 'assistant',
          contentBlocks: [
            { type: 'thinking', thinking: 'internal reasoning' },
            { type: 'text', text: 'The answer is 42.' },
          ],
        }),
      ]

      const result = distillConversation(messages)

      expect(result.messages).toHaveLength(1)
      expect(result.messages[0].text).toBe('The answer is 42.')
    })

    it('produces action line for tool_use blocks', () => {
      const messages = [
        makeMessage({
          id: 'msg-1',
          role: 'assistant',
          contentBlocks: [
            { type: 'tool_use', id: 'tu-1', name: 'Read', input: { file_path: '/foo' } },
          ],
        }),
      ]

      const result = distillConversation(messages)

      expect(result.messages).toHaveLength(1)
      expect(result.messages[0].role).toBe('action')
      expect(result.messages[0].text).toBe('[Read]')
    })

    it('merges consecutive tool_use blocks into a single action line', () => {
      const messages = [
        makeMessage({
          id: 'msg-1',
          role: 'assistant',
          contentBlocks: [
            { type: 'tool_use', id: 'tu-1', name: 'Read', input: {} },
            { type: 'tool_use', id: 'tu-2', name: 'Grep', input: {} },
            { type: 'tool_use', id: 'tu-3', name: 'Edit', input: {} },
          ],
        }),
      ]

      const result = distillConversation(messages)

      expect(result.messages).toHaveLength(1)
      expect(result.messages[0].role).toBe('action')
      expect(result.messages[0].text).toBe('[Read, Grep, Edit]')
    })

    it('produces both text and action when message has text and tool_use', () => {
      const messages = [
        makeMessage({
          id: 'msg-1',
          role: 'assistant',
          contentBlocks: [
            { type: 'text', text: 'Let me read that file.' },
            { type: 'tool_use', id: 'tu-1', name: 'Read', input: {} },
          ],
        }),
      ]

      const result = distillConversation(messages)

      expect(result.messages).toHaveLength(2)
      const assistant = result.messages.find(m => m.role === 'assistant')
      const action = result.messages.find(m => m.role === 'action')
      expect(assistant?.text).toBe('Let me read that file.')
      expect(action?.text).toBe('[Read]')
    })
  })

  describe('tool_result messages', () => {
    it('drops tool_result messages entirely', () => {
      const messages = [
        makeMessage({
          id: 'msg-1',
          role: 'user',
          contentBlocks: [
            { type: 'tool_result', tool_use_id: 'tu-1', content: 'file contents here' },
          ],
        }),
      ]

      const result = distillConversation(messages)

      expect(result.messages).toHaveLength(0)
    })

    it('drops messages where all blocks are tool_result', () => {
      const messages = [
        makeMessage({
          id: 'msg-1',
          role: 'user',
          contentBlocks: [
            { type: 'tool_result', tool_use_id: 'tu-1', content: 'result 1' },
            { type: 'tool_result', tool_use_id: 'tu-2', content: 'result 2' },
          ],
        }),
      ]

      const result = distillConversation(messages)

      expect(result.messages).toHaveLength(0)
    })
  })

  describe('system messages', () => {
    it('drops system role messages', () => {
      const messages = [
        makeMessage({
          id: 'msg-1',
          role: 'system',
          contentBlocks: [{ type: 'text', text: 'You are a helpful assistant.' }],
        }),
      ]

      const result = distillConversation(messages)

      expect(result.messages).toHaveLength(0)
    })
  })

  describe('bookend selection', () => {
    it('returns all messages when count is within N*2', () => {
      const messages = Array.from({ length: 5 }, (_, i) =>
        makeMessage({
          id: `msg-${i}`,
          role: i % 2 === 0 ? 'user' : 'assistant',
          contentBlocks: [{ type: 'text', text: `message ${i}` }],
        })
      )

      const result = distillConversation(messages, { n: 5 })

      expect(result.messages).toHaveLength(5)
    })

    it('selects first N + last N messages from a long conversation', () => {
      const messages = Array.from({ length: 30 }, (_, i) =>
        makeMessage({
          id: `msg-${i}`,
          role: i % 2 === 0 ? 'user' : 'assistant',
          contentBlocks: [{ type: 'text', text: `message ${i}` }],
        })
      )

      const result = distillConversation(messages, { n: 5 })

      // Should have messages from first 5 and last 5 = up to 10 unique messages
      expect(result.messages.length).toBeGreaterThan(0)
      expect(result.messages.length).toBeLessThanOrEqual(10)

      const texts = result.messages.map(m => m.text)
      expect(texts).toContain('message 0')
      expect(texts).toContain('message 1')
      expect(texts).toContain('message 29')
      expect(texts).toContain('message 28')
      // middle messages should not be present
      expect(texts).not.toContain('message 14')
      expect(texts).not.toContain('message 15')
    })

    it('deduplicates messages when first N and last N overlap', () => {
      const messages = Array.from({ length: 8 }, (_, i) =>
        makeMessage({
          id: `msg-${i}`,
          role: 'user',
          contentBlocks: [{ type: 'text', text: `message ${i}` }],
        })
      )

      // n=5 means first 5 and last 5 overlap on msgs 3-4
      const result = distillConversation(messages, { n: 5 })

      // No duplicates: 8 messages total, all within 5+5 window with overlap
      const ids = result.messages.map(m => m.text)
      const uniqueIds = new Set(ids)
      expect(uniqueIds.size).toBe(ids.length)
    })

    it('defaults to n=10', () => {
      // 25 messages — first 10 + last 10 = 20 unique
      const messages = Array.from({ length: 25 }, (_, i) =>
        makeMessage({
          id: `msg-${i}`,
          role: 'user',
          contentBlocks: [{ type: 'text', text: `message ${i}` }],
        })
      )

      const result = distillConversation(messages)

      // Check that middle messages (10-14) are NOT present
      const texts = result.messages.map(m => m.text)
      expect(texts).not.toContain('message 12')
    })
  })

  describe('estimatedTokens', () => {
    it('estimates tokens as sum of text.length / 4', () => {
      const messages = [
        makeMessage({
          id: 'msg-1',
          role: 'user',
          contentBlocks: [{ type: 'text', text: 'a'.repeat(400) }],
        }),
      ]

      const result = distillConversation(messages)

      // 400 chars / 4 = 100 tokens
      expect(result.estimatedTokens).toBe(100)
    })

    it('sums tokens across multiple distilled messages', () => {
      const messages = [
        makeMessage({
          id: 'msg-1',
          role: 'user',
          contentBlocks: [{ type: 'text', text: 'a'.repeat(400) }],
        }),
        makeMessage({
          id: 'msg-2',
          role: 'assistant',
          contentBlocks: [{ type: 'text', text: 'b'.repeat(400) }],
        }),
      ]

      const result = distillConversation(messages)

      // 400/4 + 400/4 = 200 tokens
      expect(result.estimatedTokens).toBe(200)
    })

    it('returns 0 for empty conversation', () => {
      const result = distillConversation([])
      expect(result.estimatedTokens).toBe(0)
      expect(result.messages).toHaveLength(0)
    })
  })

  describe('focus=tools', () => {
    it('extracts file_path basename from Read tool', () => {
      const messages = [
        makeMessage({
          id: 'msg-1',
          role: 'assistant',
          contentBlocks: [
            { type: 'tool_use', id: 'tu-1', name: 'Read', input: { file_path: '/home/kitty/src/auth.ts' } },
          ],
        }),
      ]

      const result = distillConversation(messages, { focus: 'tools' })

      expect(result.messages).toHaveLength(1)
      expect(result.messages[0].role).toBe('action')
      expect(result.messages[0].text).toBe('[Read: auth.ts]')
    })

    it('extracts MCP params (ref, footprint) from mcp tool', () => {
      const messages = [
        makeMessage({
          id: 'msg-1',
          role: 'assistant',
          contentBlocks: [
            {
              type: 'tool_use',
              id: 'tu-1',
              name: 'mcp__kicad__edit',
              input: { ref: 'U5', footprint: 'SOIC-20' },
            },
          ],
        }),
      ]

      const result = distillConversation(messages, { focus: 'tools' })

      expect(result.messages).toHaveLength(1)
      expect(result.messages[0].text).toBe('[mcp__kicad__edit: ref=U5, footprint=SOIC-20]')
    })

    it('extracts Bash command (truncated to 60 chars)', () => {
      const messages = [
        makeMessage({
          id: 'msg-1',
          role: 'assistant',
          contentBlocks: [
            { type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'npm test -- --coverage' } },
          ],
        }),
      ]

      const result = distillConversation(messages, { focus: 'tools' })

      expect(result.messages).toHaveLength(1)
      expect(result.messages[0].text).toBe('[Bash: npm test -- --coverage]')
    })

    it('falls back to just tool name when no recognizable params', () => {
      const messages = [
        makeMessage({
          id: 'msg-1',
          role: 'assistant',
          contentBlocks: [
            { type: 'tool_use', id: 'tu-1', name: 'SomeTool', input: { unrelated: 'value' } },
          ],
        }),
      ]

      const result = distillConversation(messages, { focus: 'tools' })

      expect(result.messages).toHaveLength(1)
      expect(result.messages[0].text).toBe('[SomeTool]')
    })

    it('keeps error tool results when isError=true', () => {
      const messages = [
        makeMessage({
          id: 'msg-1',
          role: 'user',
          isError: true,
          contentBlocks: [
            { type: 'tool_result', tool_use_id: 'tu-1', content: 'File not found: /missing.ts' },
          ],
        }),
      ]

      const result = distillConversation(messages, { focus: 'tools' })

      expect(result.messages).toHaveLength(1)
      expect(result.messages[0].role).toBe('action')
      expect(result.messages[0].text).toContain('File not found')
    })

    it('still drops non-error tool results', () => {
      const messages = [
        makeMessage({
          id: 'msg-1',
          role: 'user',
          isError: false,
          contentBlocks: [
            { type: 'tool_result', tool_use_id: 'tu-1', content: 'file contents here' },
          ],
        }),
      ]

      const result = distillConversation(messages, { focus: 'tools' })

      expect(result.messages).toHaveLength(0)
    })
  })

  describe('focus=errors', () => {
    const makeMsg = (
      id: string,
      opts: { isError?: boolean; isCorrection?: boolean; text?: string } = {},
    ) =>
      makeMessage({
        id,
        role: 'user',
        contentBlocks: [{ type: 'text', text: opts.text ?? `message ${id}` }],
        isError: opts.isError ?? false,
        isCorrection: opts.isCorrection ?? false,
      })

    it('keeps error messages and their ±1 context window', () => {
      const messages = [
        makeMsg('m0'),
        makeMsg('m1'),
        makeMsg('m2', { isError: true }),
        makeMsg('m3'),
        makeMsg('m4'),
      ]

      const result = distillConversation(messages, { focus: 'errors' })

      const texts = result.messages.filter(m => m.role !== 'action').map(m => m.text)
      expect(texts).toContain('message m1')
      expect(texts).toContain('message m2')
      expect(texts).toContain('message m3')
      expect(texts).not.toContain('message m0')
      expect(texts).not.toContain('message m4')
    })

    it('keeps correction messages in full', () => {
      const messages = [
        makeMsg('m0'),
        makeMsg('m1', { isCorrection: true }),
        makeMsg('m2'),
        makeMsg('m3'),
      ]

      const result = distillConversation(messages, { focus: 'errors' })

      const texts = result.messages.filter(m => m.role !== 'action').map(m => m.text)
      expect(texts).toContain('message m0')
      expect(texts).toContain('message m1')
      expect(texts).toContain('message m2')
      expect(texts).not.toContain('message m3')
    })

    it('collapses gaps between errors with [... N messages ...] markers', () => {
      const messages = [
        makeMsg('m0'),
        makeMsg('m1'),
        makeMsg('m2'),
        makeMsg('m3', { isError: true }),
        makeMsg('m4'),
        makeMsg('m5'),
        makeMsg('m6'),
        makeMsg('m7', { isError: true }),
        makeMsg('m8'),
      ]

      const result = distillConversation(messages, { focus: 'errors' })

      const actions = result.messages.filter(m => m.role === 'action').map(m => m.text)
      // Gap before m3's context window (m0, m1 are collapsed)
      expect(actions.some(t => t.includes('messages'))).toBe(true)
      // Gap between error windows (m5, m6 collapsed between m4 and m7-context)
      const gapMarkers = actions.filter(t => /\[... \d+ messages \.\.\.\]/.test(t))
      expect(gapMarkers.length).toBeGreaterThanOrEqual(1)
    })

    it('collapses everything when session has no errors or corrections', () => {
      const messages = [
        makeMsg('m0'),
        makeMsg('m1'),
        makeMsg('m2'),
      ]

      const result = distillConversation(messages, { focus: 'errors' })

      const actions = result.messages.filter(m => m.role === 'action')
      const nonActions = result.messages.filter(m => m.role !== 'action')
      expect(nonActions).toHaveLength(0)
      expect(actions).toHaveLength(1)
      expect(actions[0].text).toBe('[... 3 messages ...]')
    })

    it('merges context windows when adjacent errors overlap — no duplication', () => {
      const messages = [
        makeMsg('m0'),
        makeMsg('m1', { isError: true }),
        makeMsg('m2', { isError: true }),
        makeMsg('m3'),
        makeMsg('m4'),
      ]

      const result = distillConversation(messages, { focus: 'errors' })

      // m0, m1, m2, m3 should all be present (windows merge)
      const texts = result.messages.filter(m => m.role !== 'action').map(m => m.text)
      expect(texts).toContain('message m0')
      expect(texts).toContain('message m1')
      expect(texts).toContain('message m2')
      expect(texts).toContain('message m3')
      // No duplicates
      expect(new Set(texts).size).toBe(texts.length)
      // m4 not included
      expect(texts).not.toContain('message m4')
    })
  })

  describe('focus=files', () => {
    it('shows file tools (Read, Edit) with extracted paths', () => {
      const messages = [
        makeMessage({
          id: 'msg-1',
          role: 'assistant',
          contentBlocks: [
            { type: 'tool_use', id: 'tu-1', name: 'Read', input: { file_path: '/home/kitty/src/auth.ts' } },
            { type: 'tool_use', id: 'tu-2', name: 'Edit', input: { file_path: '/home/kitty/src/auth.ts' } },
          ],
        }),
      ]

      const result = distillConversation(messages, { focus: 'files' })

      expect(result.messages).toHaveLength(1)
      expect(result.messages[0].role).toBe('action')
      expect(result.messages[0].text).toBe('[Read: auth.ts, Edit: auth.ts]')
    })

    it('collapses non-file tools to just name', () => {
      const messages = [
        makeMessage({
          id: 'msg-1',
          role: 'assistant',
          contentBlocks: [
            { type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'npm test' } },
            { type: 'tool_use', id: 'tu-2', name: 'Read', input: { file_path: '/foo/bar.ts' } },
          ],
        }),
      ]

      const result = distillConversation(messages, { focus: 'files' })

      expect(result.messages).toHaveLength(1)
      expect(result.messages[0].text).toBe('[Bash, Read: bar.ts]')
    })

    it('truncates user and assistant text to 200 chars', () => {
      const longText = 'x'.repeat(300)
      const messages = [
        makeMessage({
          id: 'msg-1',
          role: 'user',
          contentBlocks: [{ type: 'text', text: longText }],
        }),
        makeMessage({
          id: 'msg-2',
          role: 'assistant',
          contentBlocks: [{ type: 'text', text: longText }],
        }),
      ]

      const result = distillConversation(messages, { focus: 'files' })

      expect(result.messages).toHaveLength(2)
      expect(result.messages[0].text.length).toBe(200)
      expect(result.messages[1].text.length).toBe(200)
    })
  })

  describe('focus=decisions', () => {
    it('keeps user and assistant text', () => {
      const messages = [
        makeMessage({
          id: 'msg-1',
          role: 'user',
          contentBlocks: [{ type: 'text', text: 'Should we refactor?' }],
        }),
        makeMessage({
          id: 'msg-2',
          role: 'assistant',
          contentBlocks: [{ type: 'text', text: 'Yes, extract a helper.' }],
        }),
      ]

      const result = distillConversation(messages, { focus: 'decisions' })

      expect(result.messages).toHaveLength(2)
      expect(result.messages[0].text).toBe('Should we refactor?')
      expect(result.messages[1].text).toBe('Yes, extract a helper.')
    })

    it('drops all tool_use blocks — no action lines in output', () => {
      const messages = [
        makeMessage({
          id: 'msg-1',
          role: 'assistant',
          contentBlocks: [
            { type: 'text', text: 'Let me check that.' },
            { type: 'tool_use', id: 'tu-1', name: 'Read', input: { file_path: '/foo.ts' } },
            { type: 'tool_use', id: 'tu-2', name: 'Bash', input: { command: 'ls' } },
          ],
        }),
      ]

      const result = distillConversation(messages, { focus: 'decisions' })

      expect(result.messages.every(m => m.role !== 'action')).toBe(true)
      expect(result.messages).toHaveLength(1)
      expect(result.messages[0].text).toBe('Let me check that.')
    })

    it('drops tool_result messages', () => {
      const messages = [
        makeMessage({
          id: 'msg-1',
          role: 'user',
          contentBlocks: [
            { type: 'tool_result', tool_use_id: 'tu-1', content: 'file output' },
          ],
        }),
      ]

      const result = distillConversation(messages, { focus: 'decisions' })

      expect(result.messages).toHaveLength(0)
    })
  })

  describe('edge cases', () => {
    it('handles assistant message with only thinking blocks (produces nothing)', () => {
      const messages = [
        makeMessage({
          id: 'msg-1',
          role: 'assistant',
          contentBlocks: [{ type: 'thinking', thinking: 'deep thoughts' }],
        }),
      ]

      const result = distillConversation(messages)

      expect(result.messages).toHaveLength(0)
    })

    it('handles empty contentBlocks', () => {
      const messages = [
        makeMessage({
          id: 'msg-1',
          role: 'user',
          contentBlocks: [],
        }),
      ]

      const result = distillConversation(messages)

      expect(result.messages).toHaveLength(0)
    })

    it('handles user message with text and tool_result blocks — drops tool_result, keeps text', () => {
      // A user message that has mixed content: tool_result + text
      // Since not ALL blocks are tool_result, keep the text block
      const messages = [
        makeMessage({
          id: 'msg-1',
          role: 'user',
          contentBlocks: [
            { type: 'tool_result', tool_use_id: 'tu-1', content: 'result' },
            { type: 'text', text: 'What do you think?' },
          ],
        }),
      ]

      const result = distillConversation(messages)

      expect(result.messages).toHaveLength(1)
      expect(result.messages[0].text).toBe('What do you think?')
    })
  })
})
