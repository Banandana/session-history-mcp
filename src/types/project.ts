export interface ProjectMeta {
  readonly slug: string
  readonly path: string
  readonly source: string
  readonly sessionCount: number
  readonly lastActive?: string
  readonly branches?: readonly string[]
  readonly hasMemory: boolean
  readonly hasClaudeMd: boolean
}

export interface ProjectDetail extends ProjectMeta {
  readonly claudeMd?: string
  readonly settings?: ProjectSettings
  readonly stats?: ProjectStats
}

export interface ProjectSettings {
  readonly model?: string
  readonly permissions?: Record<string, unknown>
  readonly hooks?: Record<string, unknown>
}

export interface ProjectStats {
  readonly totalTokensByModel?: Record<string, number>
  readonly totalSessions?: number
  readonly dailyActivity?: Record<string, number>
}

export interface MemoryEntry {
  readonly projectSlug: string
  readonly fileName: string
  readonly name: string
  readonly description: string
  readonly type: 'user' | 'feedback' | 'project' | 'reference'
  readonly content: string
}
