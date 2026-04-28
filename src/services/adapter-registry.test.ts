import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { AdapterRegistry } from './adapter-registry'
import { ClaudeCodeAdapter } from '../adapters/claude-code/index'
import type {
  ProjectMeta,
  SessionMeta,
  NormalizedMessage,
  MemoryEntry,
} from '../types'

const FIXTURES = join(__dirname, '../../fixtures/claude-home')

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = []
  for await (const item of iter) {
    items.push(item)
  }
  return items
}

describe('AdapterRegistry', () => {
  it('starts with no adapters', () => {
    const registry = new AdapterRegistry()
    expect(registry.getAdapters()).toHaveLength(0)
  })

  it('registers an adapter', () => {
    const registry = new AdapterRegistry()
    const adapter = new ClaudeCodeAdapter(FIXTURES)
    registry.registerAdapter(adapter)
    expect(registry.getAdapters()).toHaveLength(1)
  })

  describe('with ClaudeCodeAdapter', () => {
    const registry = new AdapterRegistry()
    const adapter = new ClaudeCodeAdapter(FIXTURES)
    registry.registerAdapter(adapter)

    it('discovers projects through registry', async () => {
      const projects = await collect<ProjectMeta>(registry.discoverProjects())
      expect(projects.length).toBe(2)
    })

    it('discovers sessions through registry', async () => {
      const sessions = await collect<SessionMeta>(registry.discoverSessions())
      expect(sessions.length).toBeGreaterThanOrEqual(2)
    })

    it('gets messages through registry', async () => {
      const messages = await collect<NormalizedMessage>(
        registry.getMessages('aaaaaaaa-1111-2222-3333-444444444444'),
      )
      expect(messages.length).toBeGreaterThan(0)
    })

    it('gets memory through registry', async () => {
      const entries = await collect<MemoryEntry>(registry.getMemory())
      expect(entries.length).toBeGreaterThan(0)
    })

    it('resolveProject returns undefined for unknown path', async () => {
      const result = await registry.resolveProject('/nonexistent/path')
      expect(result).toBeUndefined()
    })

    it('checkFreshness merges results from all adapters', async () => {
      const result = await registry.checkFreshness({
        sessionOffsets: new Map(),
        lastSyncAt: new Date().toISOString(),
      })
      expect(result.isStale).toBe(true)
      expect(result.newSessions.length).toBeGreaterThan(0)
    })
  })

  describe('empty registry', () => {
    const registry = new AdapterRegistry()

    it('yields nothing for discoverProjects', async () => {
      const projects = await collect<ProjectMeta>(registry.discoverProjects())
      expect(projects).toHaveLength(0)
    })

    it('resolveProject returns undefined', async () => {
      expect(await registry.resolveProject('/any/path')).toBeUndefined()
    })

    it('checkFreshness returns not stale', async () => {
      const result = await registry.checkFreshness({
        sessionOffsets: new Map(),
        lastSyncAt: new Date().toISOString(),
      })
      expect(result.isStale).toBe(false)
    })
  })
})
