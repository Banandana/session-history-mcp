import { join } from 'node:path'
import type { ProjectSettings, ProjectStats } from '../../types'
import { fileExists, readTextFile, readJsonFile } from '../../infrastructure/file-system'

export interface ProjectConfig {
  readonly lastCost?: number
  readonly lastTotalInputTokens?: number
  readonly lastTotalOutputTokens?: number
  readonly lastTotalCacheCreationInputTokens?: number
  readonly lastTotalCacheReadInputTokens?: number
  readonly lastSessionId?: string
  readonly lastModelUsage?: Record<string, {
    readonly inputTokens?: number
    readonly outputTokens?: number
    readonly cacheReadInputTokens?: number
    readonly cacheCreationInputTokens?: number
    readonly costUSD?: number
  }>
}

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

  async readProjectConfig(projectSlug: string): Promise<ProjectConfig | undefined> {
    const path = join(this.claudeDir, 'projects', projectSlug, '.config.json')
    return this.readJsonOrUndefined<ProjectConfig>(path)
  }

  /**
   * Get cost for a specific session from the project's .config.json.
   * Only returns cost if the session was the last one recorded.
   */
  async getSessionCost(projectSlug: string, sessionId: string): Promise<number | undefined> {
    const config = await this.readProjectConfig(projectSlug)
    if (!config) return undefined
    if (config.lastSessionId === sessionId && config.lastCost !== undefined) {
      return config.lastCost
    }
    // Cost from lastModelUsage aggregate if this was the last session
    if (config.lastSessionId === sessionId && config.lastModelUsage) {
      let total = 0
      for (const usage of Object.values(config.lastModelUsage)) {
        total += usage.costUSD ?? 0
      }
      return total > 0 ? total : undefined
    }
    return undefined
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
