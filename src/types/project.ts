export interface ProjectMeta {
  readonly slug: string
  readonly path: string
  readonly source: string
  readonly sessionCount: number
  readonly lastActive?: string | undefined
  readonly branches?: readonly string[] | undefined
  readonly hasMemory: boolean
  readonly hasClaudeMd: boolean
}

export interface ProjectDetail extends ProjectMeta {
  readonly claudeMd?: string | undefined
  readonly settings?: ProjectSettings | undefined
  readonly stats?: ProjectStats | undefined
}

export interface ProjectSettings {
  readonly model?: string | undefined
  readonly permissions?: Record<string, unknown> | undefined
  readonly hooks?: Record<string, unknown> | undefined
}

export interface ProjectStats {
  readonly totalTokensByModel?: Record<string, number> | undefined
  readonly totalSessions?: number | undefined
  readonly dailyActivity?: Record<string, number> | undefined
}

export interface MemoryEntry {
  readonly projectSlug: string
  readonly fileName: string
  readonly name: string
  readonly description: string
  readonly type: 'user' | 'feedback' | 'project' | 'reference'
  readonly content: string
}
