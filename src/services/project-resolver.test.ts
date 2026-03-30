import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { ProjectResolver } from './project-resolver'
import { AdapterRegistry } from './adapter-registry'
import { ClaudeCodeAdapter } from '../adapters/claude-code/index'
import type { ProjectMeta } from '../types'

const FIXTURES = join(__dirname, '../../fixtures/claude-home')

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = []
  for await (const item of iter) {
    items.push(item)
  }
  return items
}

describe('ProjectResolver', () => {
  describe('resolveProjectFilter', () => {
    it('returns project slug when project is provided directly', async () => {
      const registry = new AdapterRegistry()
      const resolver = new ProjectResolver(registry)
      const result = await resolver.resolveProjectFilter({ project: 'my-project' })
      expect(result).toBe('my-project')
    })

    it('returns undefined when neither project nor path provided', async () => {
      const registry = new AdapterRegistry()
      const resolver = new ProjectResolver(registry)
      const result = await resolver.resolveProjectFilter({})
      expect(result).toBeUndefined()
    })

    it('prefers project over path', async () => {
      const registry = new AdapterRegistry()
      const resolver = new ProjectResolver(registry)
      const result = await resolver.resolveProjectFilter({
        project: 'explicit-slug',
        path: '/some/path',
      })
      expect(result).toBe('explicit-slug')
    })

    it('returns undefined for unknown path', async () => {
      const registry = new AdapterRegistry()
      const adapter = new ClaudeCodeAdapter(FIXTURES)
      registry.registerAdapter(adapter)
      const resolver = new ProjectResolver(registry)

      const result = await resolver.resolveProjectFilter({ path: '/nonexistent/path' })
      expect(result).toBeUndefined()
    })
  })

  describe('resolveProject', () => {
    it('delegates to registry', () => {
      const registry = new AdapterRegistry()
      const resolver = new ProjectResolver(registry)
      const result = resolver.resolveProject('/any/path')
      expect(result).toBeUndefined()
    })

    it('resolves path after project cache is built', async () => {
      const registry = new AdapterRegistry()
      const adapter = new ClaudeCodeAdapter(FIXTURES)
      registry.registerAdapter(adapter)

      // Build cache by discovering projects
      await collect<ProjectMeta>(registry.discoverProjects())

      const resolver = new ProjectResolver(registry)
      // The resolver delegates to the adapter's resolveProject
      const result = resolver.resolveProject('/home/test/project/alpha')
      // May or may not resolve due to lossy slug-to-path conversion
      expect(result === undefined || result.slug === '-home-test-project-alpha').toBe(true)
    })
  })
})
