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

  async resolveProject(path: string): Promise<ProjectMeta | undefined> {
    for (const adapter of this.adapters) {
      const result = await adapter.resolveProject(path)
      if (result) return result
    }
    return undefined
  }

  async checkFreshness(known: IndexState): Promise<FreshnessResult> {
    const newSessions: string[] = []
    const changedSessions: string[] = []

    // Multi-adapter removal semantics: a session is "really removed" only if EVERY
    // adapter agrees it's gone. Each individual adapter's checkFreshness flags any
    // id it doesn't own as removed (claude-code adapter does this), so unioning
    // removedSessions would nuke any other adapter's sessions on every sync.
    // Intersection: start with the set from the first adapter, keep paring down.
    let removedIntersection: Set<string> | undefined

    for (const adapter of this.adapters) {
      const result = await adapter.checkFreshness(known)
      newSessions.push(...result.newSessions)
      changedSessions.push(...result.changedSessions)

      const removedSet = new Set(result.removedSessions)
      if (removedIntersection === undefined) {
        removedIntersection = removedSet
      } else {
        for (const id of removedIntersection) {
          if (!removedSet.has(id)) removedIntersection.delete(id)
        }
      }
    }

    // Also: any id reported new or changed by ANY adapter must NOT be removed.
    const claimed = new Set<string>([...newSessions, ...changedSessions])
    const removedSessions: string[] = []
    if (removedIntersection) {
      for (const id of removedIntersection) {
        if (!claimed.has(id)) removedSessions.push(id)
      }
    }

    return {
      isStale: newSessions.length > 0 || changedSessions.length > 0 || removedSessions.length > 0,
      newSessions,
      changedSessions,
      removedSessions,
    }
  }
}
