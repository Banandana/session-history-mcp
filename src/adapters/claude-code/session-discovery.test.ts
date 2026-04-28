import { describe, it, expect } from 'vitest'
import { SessionDiscovery } from './session-discovery'
import { join } from 'node:path'

const FIXTURES = join(__dirname, '../../../fixtures/claude-home')

describe('SessionDiscovery', () => {
  const discovery = new SessionDiscovery(FIXTURES)

  it('discovers all projects', async () => {
    const projects: any[] = []
    for await (const p of discovery.discoverProjects()) {
      projects.push(p)
    }
    expect(projects).toHaveLength(2)
    expect(projects.map(p => p.slug).sort()).toEqual([
      '-home-test-project-alpha',
      '-home-test-project-beta',
    ])
  })

  it('uses real cwd from session JSONL (not the lossy slug heuristic)', async () => {
    const projects: any[] = []
    for await (const p of discovery.discoverProjects()) {
      projects.push(p)
    }
    const alpha = projects.find(p => p.slug === '-home-test-project-alpha')
    // Real cwd preserves hyphens: /home/test/project-alpha, not /home/test/project/alpha
    expect(alpha.path).toBe('/home/test/project-alpha')
  })

  it('discovers sessions for a project', async () => {
    const sessions: any[] = []
    for await (const s of discovery.discoverSessions('-home-test-project-alpha')) {
      sessions.push(s)
    }
    expect(sessions).toHaveLength(2)
    const alpha = sessions.find(s => s.id === 'aaaaaaaa-1111-2222-3333-444444444444')
    expect(alpha).toBeDefined()
    expect(alpha!.branch).toBe('feat/auth')
  })

  it('discovers sessions across all projects when no filter', async () => {
    const sessions: any[] = []
    for await (const s of discovery.discoverSessions()) {
      sessions.push(s)
    }
    expect(sessions.length).toBeGreaterThanOrEqual(2)
  })

  it('resolves project from real path (with hyphen) after cache built', async () => {
    await discovery.buildProjectCache()
    const project = await discovery.resolveProject('/home/test/project-alpha/src/auth')
    expect(project).toBeDefined()
    expect(project!.slug).toBe('-home-test-project-alpha')
  })

  it('returns undefined for unknown path after cache built', async () => {
    await discovery.buildProjectCache()
    expect(await discovery.resolveProject('/unknown/path')).toBeUndefined()
  })

  it('lazy-builds cache on cold resolveProject call', async () => {
    const fresh = new SessionDiscovery(FIXTURES)
    const project = await fresh.resolveProject('/home/test/project-alpha')
    expect(project?.slug).toBe('-home-test-project-alpha')
  })
})
