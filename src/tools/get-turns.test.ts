import 'reflect-metadata'
import { describe, it, expect } from 'vitest'
import { truncateBlocks, truncateTurns } from './get-turns'
import type { ContentBlock } from '../types'

describe('truncateBlocks', () => {
  it('returns blocks unchanged when within budget', () => {
    const blocks: ContentBlock[] = [{ type: 'text', text: 'hello' }]
    const result = truncateBlocks(blocks, 1000)
    expect(result.truncated).toBe(false)
    expect(result.blocks).toEqual(blocks)
  })

  it('truncates tool_result content first', () => {
    const blocks: ContentBlock[] = [
      { type: 'tool_result', tool_use_id: '1', content: 'x'.repeat(2000) },
      { type: 'text', text: 'keep this' },
    ]
    const result = truncateBlocks(blocks, 100)
    expect(result.truncated).toBe(true)
    const toolResult = result.blocks.find(b => b.type === 'tool_result')
    expect(typeof toolResult?.content === 'string' && toolResult.content.length).toBeLessThan(2000)
  })

  it('truncates tool_use input as second pass', () => {
    const blocks: ContentBlock[] = [
      { type: 'tool_use', name: 'Bash', input: { command: 'x'.repeat(2000) } },
    ]
    const result = truncateBlocks(blocks, 10)
    expect(result.truncated).toBe(true)
    const toolUse = result.blocks.find(b => b.type === 'tool_use')
    expect(toolUse?.input).toEqual({ _truncated: true })
  })
})

describe('truncateTurns', () => {
  it('drops middle turns when per-turn truncation is insufficient', () => {
    const makeTurn = (idx: number) => ({
      turnIndex: idx, turnId: `t${idx}`, role: 'assistant' as const,
      timestamp: '2026-01-01T00:00:00Z',
      contentBlocks: [{ type: 'text' as const, text: 'x'.repeat(1000) }],
      toolNames: [] as string[], isError: false, isCorrection: false, hasThinking: false,
    })
    const turns = Array.from({ length: 10 }, (_, i) => makeTurn(i))
    const result = truncateTurns(turns, 20)
    expect(result.truncated).toBe(true)
    expect(result.turns.length).toBeLessThan(10)
    expect(result.turns[0].turnIndex).toBe(0)
    expect(result.turns[result.turns.length - 1].turnIndex).toBe(9)
  })
})
