import type {
  SessionAdapter,
  SessionMetadataResult,
  IndexState,
  FreshnessResult,
  ProjectMeta,
  SessionMeta,
  NormalizedMessage,
  FileChange,
  SubagentMeta,
  MemoryEntry,
} from '../types'

export class AdapterRegistry {
  private readonly adapters: SessionAdapter[] = []

  registerAdapter(adapter: SessionAdapter): void {
    this.adapters.push(adapter)
  }

  getAdapters(): readonly SessionAdapter[] {
    return this.adapters
  }

  async *discoverProjects(): AsyncIterable<ProjectMeta> {
    for (const adapter of this.adapters) {
      yield* adapter.discoverProjects()
    }
  }

  async *discoverSessions(project?: string): AsyncIterable<SessionMeta> {
    for (const adapter of this.adapters) {
      yield* adapter.discoverSessions(project)
    }
  }

  async *getMessages(sessionId: string): AsyncIterable<NormalizedMessage> {
    for (const adapter of this.adapters) {
      yield* adapter.getMessages(sessionId)
    }
  }

  async *getFileChanges(sessionId: string): AsyncIterable<FileChange> {
    for (const adapter of this.adapters) {
      yield* adapter.getFileChanges(sessionId)
    }
  }

  async *getSubagents(sessionId: string): AsyncIterable<SubagentMeta> {
    for (const adapter of this.adapters) {
      yield* adapter.getSubagents(sessionId)
    }
  }

  async *getMemory(project?: string): AsyncIterable<MemoryEntry> {
    for (const adapter of this.adapters) {
      yield* adapter.getMemory(project)
    }
  }

  async getSessionMetadata(sessionId: string): Promise<SessionMetadataResult | undefined> {
    for (const adapter of this.adapters) {
      const result = await adapter.getSessionMetadata(sessionId)
      if (result) return result
    }
    return undefined
  }

  async getSessionCost(projectSlug: string, sessionId: string): Promise<number | undefined> {
    for (const adapter of this.adapters) {
      const result = await adapter.getSessionCost(projectSlug, sessionId)
      if (result !== undefined) return result
    }
    return undefined
  }

  resolveProject(path: string): ProjectMeta | undefined {
    for (const adapter of this.adapters) {
      const result = adapter.resolveProject(path)
      if (result) return result
    }
    return undefined
  }

  async checkFreshness(known: IndexState): Promise<FreshnessResult> {
    const merged: FreshnessResult = {
      isStale: false,
      newSessions: [],
      changedSessions: [],
      removedSessions: [],
    }

    for (const adapter of this.adapters) {
      const result = await adapter.checkFreshness(known)
      ;(merged.newSessions as string[]).push(...result.newSessions)
      ;(merged.changedSessions as string[]).push(...result.changedSessions)
      ;(merged.removedSessions as string[]).push(...result.removedSessions)
    }

    return {
      isStale: merged.newSessions.length > 0 || merged.changedSessions.length > 0 || merged.removedSessions.length > 0,
      newSessions: merged.newSessions,
      changedSessions: merged.changedSessions,
      removedSessions: merged.removedSessions,
    }
  }
}
