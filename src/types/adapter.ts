import type { ProjectMeta } from './project'
import type { SessionMeta, NormalizedMessage, FileChange, SubagentMeta } from './session'
import type { MemoryEntry } from './project'

export interface IndexState {
  readonly sessionOffsets: ReadonlyMap<string, number>
  readonly lastSyncAt: string
}

export interface FreshnessResult {
  readonly isStale: boolean
  readonly newSessions: readonly string[]
  readonly changedSessions: readonly string[]
  readonly removedSessions: readonly string[]
}

export interface SessionAdapter {
  readonly source: string
  discoverProjects(): AsyncIterable<ProjectMeta>
  discoverSessions(project?: string): AsyncIterable<SessionMeta>
  getMessages(sessionId: string): AsyncIterable<NormalizedMessage>
  getFileChanges(sessionId: string): AsyncIterable<FileChange>
  getSubagents(sessionId: string): AsyncIterable<SubagentMeta>
  getMemory(project?: string): AsyncIterable<MemoryEntry>
  resolveProject(path: string): ProjectMeta | undefined
  checkFreshness(known: IndexState): Promise<FreshnessResult>
}
