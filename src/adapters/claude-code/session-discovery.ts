import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProjectMeta, SessionMeta } from '../../types'
import { readJsonFile, fileExists, listFiles } from '../../infrastructure/file-system'

const UUID_JSONL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/

interface SessionsIndexEntry {
  readonly sessionId: string
  readonly firstPrompt?: string
  readonly created?: string
  readonly modified?: string
  readonly fileMtime?: number
  readonly gitBranch?: string
}

interface SessionsIndex {
  readonly version: number
  readonly entries: readonly SessionsIndexEntry[]
}

function slugToPath(slug: string): string {
  // Strip leading '-', then replace the first '-' in each segment with '/'
  // The slug format is: -home-test-project-alpha
  // Which maps to: /home/test/project-alpha
  // Strategy: leading '-' becomes '/', remaining '-' become '/' EXCEPT
  // hyphens that are part of directory names (ambiguous).
  // Heuristic: strip leading dash, split on '-', rejoin with '/'
  // This is lossy — hyphens in real dir names become separators.
  const stripped = slug.startsWith('-') ? slug.slice(1) : slug
  return '/' + stripped.replace(/-/g, '/')
}

export class SessionDiscovery {
  private readonly claudeDir: string
  private projectCache: Map<string, ProjectMeta> = new Map()

  constructor(claudeDir: string) {
    this.claudeDir = claudeDir
  }

  async *discoverProjects(): AsyncIterable<ProjectMeta> {
    const projectsDir = join(this.claudeDir, 'projects')
    if (!(await fileExists(projectsDir))) return

    const entries = await readdir(projectsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const slug = entry.name
      const projectDir = join(projectsDir, slug)
      const derivedPath = slugToPath(slug)

      // Count UUID .jsonl files
      const files = await listFiles(projectDir, '.jsonl')
      const sessionCount = files.filter(f => UUID_JSONL.test(f)).length

      // Check for memory directory
      const memoryDir = join(projectDir, 'memory')
      const hasMemory = await fileExists(memoryDir)

      // Check for CLAUDE.md at derived project path
      const claudeMdPath = join(derivedPath, 'CLAUDE.md')
      const hasClaudeMd = await fileExists(claudeMdPath)

      const project: ProjectMeta = {
        slug,
        path: derivedPath,
        source: 'claude-code',
        sessionCount,
        hasMemory,
        hasClaudeMd,
      }

      yield project
    }
  }

  async *discoverSessions(projectSlug?: string): AsyncIterable<SessionMeta> {
    const projectsDir = join(this.claudeDir, 'projects')
    if (!(await fileExists(projectsDir))) return

    const entries = await readdir(projectsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (projectSlug && entry.name !== projectSlug) continue

      const slug = entry.name
      const projectDir = join(projectsDir, slug)
      const indexPath = join(projectDir, 'sessions-index.json')

      if (await fileExists(indexPath)) {
        // Use sessions-index.json
        const index = await readJsonFile<SessionsIndex>(indexPath)
        for (const e of index.entries) {
          const session: SessionMeta = {
            id: e.sessionId,
            source: 'claude-code',
            projectSlug: slug,
            cwd: slugToPath(slug),
            branch: e.gitBranch,
            startedAt: e.created ?? new Date(e.fileMtime ?? 0).toISOString(),
            summaryText: e.firstPrompt,
          }
          yield session
        }
      } else {
        // Fall back to listing UUID .jsonl files
        const files = await listFiles(projectDir, '.jsonl')
        for (const file of files) {
          if (!UUID_JSONL.test(file)) continue
          const sessionId = file.replace('.jsonl', '')
          const filePath = join(projectDir, file)
          const fileStat = await stat(filePath)

          const session: SessionMeta = {
            id: sessionId,
            source: 'claude-code',
            projectSlug: slug,
            cwd: slugToPath(slug),
            startedAt: fileStat.birthtime.toISOString(),
          }
          yield session
        }
      }
    }
  }

  resolveProject(path: string): ProjectMeta | undefined {
    // Walk up directory tree, convert each path to slug, check cache
    let current = path
    while (current && current !== '/') {
      // Convert path to slug: strip leading '/', replace '/' with '-', prefix with '-'
      const slug = '-' + current.slice(1).replace(/\//g, '-')
      const project = this.projectCache.get(slug)
      if (project) return project
      // Move up one directory
      const lastSlash = current.lastIndexOf('/')
      current = lastSlash > 0 ? current.slice(0, lastSlash) : '/'
    }
    return undefined
  }

  async buildProjectCache(): Promise<void> {
    this.projectCache.clear()
    for await (const project of this.discoverProjects()) {
      this.projectCache.set(project.slug, project)
    }
  }
}
