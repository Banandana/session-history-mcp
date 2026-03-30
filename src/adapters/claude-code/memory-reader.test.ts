import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { MemoryReader } from './memory-reader'
import type { MemoryEntry } from '../../types'

const CLAUDE_HOME = join(__dirname, '../../../fixtures/claude-home')

async function collectMemory(reader: MemoryReader, projectSlug?: string): Promise<MemoryEntry[]> {
  const entries: MemoryEntry[] = []
  for await (const entry of reader.readMemory(projectSlug)) {
    entries.push(entry)
  }
  return entries
}

describe('MemoryReader', () => {
  const reader = new MemoryReader(CLAUDE_HOME)

  it('reads memory entries for a specific project', async () => {
    const entries = await collectMemory(reader, '-home-test-project-alpha')
    expect(entries).toHaveLength(1)

    const entry = entries[0]
    expect(entry.projectSlug).toBe('-home-test-project-alpha')
    expect(entry.fileName).toBe('feedback_testing.md')
    expect(entry.name).toBe('testing-feedback')
    expect(entry.description).toBe("Don't mock the database in integration tests")
    expect(entry.type).toBe('feedback')
    expect(entry.content).toContain('Integration tests must hit a real database')
  })

  it('parses YAML frontmatter correctly', async () => {
    const entries = await collectMemory(reader, '-home-test-project-alpha')
    const entry = entries[0]
    expect(entry.name).toBe('testing-feedback')
    expect(entry.type).toBe('feedback')
    expect(entry.content).toContain('**Why:**')
    expect(entry.content).toContain('**How to apply:**')
  })

  it('skips MEMORY.md index file', async () => {
    const entries = await collectMemory(reader, '-home-test-project-alpha')
    const fileNames = entries.map(e => e.fileName)
    expect(fileNames).not.toContain('MEMORY.md')
  })

  it('reads memory from all projects when no slug provided', async () => {
    const entries = await collectMemory(reader)
    // alpha has 1 memory file, beta has none
    expect(entries.length).toBeGreaterThanOrEqual(1)
    const slugs = new Set(entries.map(e => e.projectSlug))
    expect(slugs.has('-home-test-project-alpha')).toBe(true)
  })

  it('handles missing memory directory gracefully', async () => {
    const entries = await collectMemory(reader, '-home-test-project-beta')
    expect(entries).toHaveLength(0)
  })

  it('handles non-existent project slug gracefully', async () => {
    const entries = await collectMemory(reader, '-nonexistent-project')
    expect(entries).toHaveLength(0)
  })
})
