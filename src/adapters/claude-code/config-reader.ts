import { join } from 'node:path'
import type { ProjectSettings, ProjectStats } from '../../types'
import { fileExists, readTextFile, readJsonFile } from '../../infrastructure/file-system'

export class ConfigReader {
  constructor(private readonly claudeDir: string) {}

  async readGlobalClaudeMd(): Promise<string | undefined> {
    const path = join(this.claudeDir, 'CLAUDE.md')
    return this.readTextOrUndefined(path)
  }

  async readSettings(): Promise<ProjectSettings | undefined> {
    const path = join(this.claudeDir, 'settings.json')
    return this.readJsonOrUndefined<ProjectSettings>(path)
  }

  async readLocalSettings(): Promise<Record<string, unknown> | undefined> {
    const path = join(this.claudeDir, 'settings.local.json')
    return this.readJsonOrUndefined<Record<string, unknown>>(path)
  }

  async readStatsCache(): Promise<ProjectStats | undefined> {
    const path = join(this.claudeDir, 'stats-cache.json')
    return this.readJsonOrUndefined<ProjectStats>(path)
  }

  async readProjectClaudeMd(projectPath: string): Promise<string | undefined> {
    const path = join(projectPath, 'CLAUDE.md')
    return this.readTextOrUndefined(path)
  }

  private async readTextOrUndefined(path: string): Promise<string | undefined> {
    if (!(await fileExists(path))) return undefined
    try {
      return await readTextFile(path)
    } catch {
      return undefined
    }
  }

  private async readJsonOrUndefined<T>(path: string): Promise<T | undefined> {
    if (!(await fileExists(path))) return undefined
    try {
      return await readJsonFile<T>(path)
    } catch {
      return undefined
    }
  }
}
