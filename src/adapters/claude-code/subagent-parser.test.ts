import { describe, it, expect, beforeAll } from 'vitest'
import { join } from 'node:path'
import { SubagentParser } from './subagent-parser'
import type { SubagentMeta } from '../../types'

const CLAUDE_HOME = join(__dirname, '../../../fixtures/claude-home')

async function collectSubagents(
  parser: SubagentParser,
  projectSlug: string,
  sessionId: string,
): Promise<SubagentMeta[]> {
  const results: SubagentMeta[] = []
  for await (const sub of parser.getSubagents(projectSlug, sessionId)) {
    results.push(sub)
  }
  return results
}

describe('SubagentParser', () => {
  const parser = new SubagentParser(CLAUDE_HOME)

  it('discovers subagents for a session', async () => {
    const subs = await collectSubagents(
      parser,
      '-home-test-project-alpha',
      'aaaaaaaa-1111-2222-3333-444444444444',
    )
    expect(subs).toHaveLength(2)
    const ids = subs.map(s => s.id).sort()
    expect(ids).toEqual(['a1234567890abcdef', 'b9876543210fedcba'])
  })

  it('reads meta.json when present', async () => {
    const subs = await collectSubagents(
      parser,
      '-home-test-project-alpha',
      'aaaaaaaa-1111-2222-3333-444444444444',
    )
    const withMeta = subs.find(s => s.id === 'a1234567890abcdef')!
    expect(withMeta.agentType).toBe('Explore')
    expect(withMeta.description).toBe('Research authentication patterns')
    expect(withMeta.sessionId).toBe('aaaaaaaa-1111-2222-3333-444444444444')
  })

  it('handles missing meta.json gracefully', async () => {
    const subs = await collectSubagents(
      parser,
      '-home-test-project-alpha',
      'aaaaaaaa-1111-2222-3333-444444444444',
    )
    const withoutMeta = subs.find(s => s.id === 'b9876543210fedcba')!
    expect(withoutMeta.agentType).toBeUndefined()
    expect(withoutMeta.description).toBeUndefined()
  })

  it('returns empty for non-existent session', async () => {
    const subs = await collectSubagents(
      parser,
      '-home-test-project-alpha',
      'nonexistent-session-id',
    )
    expect(subs).toHaveLength(0)
  })

  it('returns empty for non-existent project', async () => {
    const subs = await collectSubagents(
      parser,
      '-nonexistent-project',
      'aaaaaaaa-1111-2222-3333-444444444444',
    )
    expect(subs).toHaveLength(0)
  })

  describe('JSONL-derived metadata', () => {
    let sub: SubagentMeta

    beforeAll(async () => {
      const subs = await collectSubagents(
        parser,
        '-home-test-project-alpha',
        'dddddddd-1111-2222-3333-444444444444',
      )
      const found = subs.find(s => s.id === 'abc123')
      if (!found) throw new Error('subagent abc123 not found in fixture')
      sub = found
    })

    it('computes totalTokens from JSONL token usage', () => {
      // (50+30) + (80+20) + (100+15) = 295
      expect(sub.totalTokens).toBe(295)
    })

    it('computes totalTools from tool_use blocks', () => {
      // Glob + Read = 2
      expect(sub.totalTools).toBe(2)
    })

    it('computes durationMs from first to last timestamp', () => {
      // 10:01:00Z to 10:01:15Z = 15000ms
      expect(sub.durationMs).toBe(15000)
    })

    it('extracts model from first assistant message', () => {
      expect(sub.model).toBe('claude-sonnet-4-6')
    })
  })
})
