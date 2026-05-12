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
  /** sessionId -> owning adapter. Populated lazily by discoverSessions / checkFreshness / getOwner probes. */
  private readonly ownerCache = new Map<string, SessionAdapter>()

  registerAdapter(adapter: SessionAdapter): void {
    this.adapters.push(adapter)
  }

  getAdapters(): readonly SessionAdapter[] {
    return this.adapters
  }

  /** Cache helper: probe adapters via claimsSessionId() if owner is unknown. */
  private async getOwner(sessionId: string): Promise<SessionAdapter | undefined> {
    const cached = this.ownerCache.get(sessionId)
    if (cached) return cached
    for (const adapter of this.adapters) {
      if (await adapter.claimsSessionId(sessionId)) {
        this.ownerCache.set(sessionId, adapter)
        return adapter
      }
    }
    return undefined
  }

  async *discoverProjects(): AsyncIterable<ProjectMeta> {
    for (const adapter of this.adapters) {
      yield* adapter.discoverProjects()
    }
  }

  async *discoverSessions(project?: string): AsyncIterable<SessionMeta> {
    for (const adapter of this.adapters) {
      for await (const session of adapter.discoverSessions(project)) {
        this.ownerCache.set(session.id, adapter)
        yield session
      }
    }
  }

  async *getMessages(sessionId: string): AsyncIterable<NormalizedMessage> {
    const owner = await this.getOwner(sessionId)
    if (owner) {
      yield* owner.getMessages(sessionId)
      return
    }
    for (const adapter of this.adapters) {
      yield* adapter.getMessages(sessionId)
    }
  }

  async *getFileChanges(sessionId: string): AsyncIterable<FileChange> {
    const owner = await this.getOwner(sessionId)
    if (owner) {
      yield* owner.getFileChanges(sessionId)
      return
    }
    for (const adapter of this.adapters) {
      yield* adapter.getFileChanges(sessionId)
    }
  }

  async *getSubagents(sessionId: string): AsyncIterable<SubagentMeta> {
    const owner = await this.getOwner(sessionId)
    if (owner) {
      yield* owner.getSubagents(sessionId)
      return
    }
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
    const owner = await this.getOwner(sessionId)
    if (owner) return owner.getSessionMetadata(sessionId)
    for (const adapter of this.adapters) {
      const result = await adapter.getSessionMetadata(sessionId)
      if (result) return result
    }
    return undefined
  }

  async getSessionCost(projectSlug: string, sessionId: string): Promise<number | undefined> {
    const owner = await this.getOwner(sessionId)
    if (owner) return owner.getSessionCost(projectSlug, sessionId)
    for (const adapter of this.adapters) {
      const result = await adapter.getSessionCost(projectSlug, sessionId)
      if (result !== undefined) return result
    }
    return undefined
  }

  async getSessionSize(sessionId: string): Promise<number | undefined> {
    const owner = await this.getOwner(sessionId)
    if (owner) return owner.getSessionSize(sessionId)
    for (const adapter of this.adapters) {
      const result = await adapter.getSessionSize(sessionId)
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
    const removedSessions: string[] = []

    // Partition known sessionOffsets by claiming adapter. Ids that no adapter
    // claims become "orphans" and are reported as removed — they no longer exist
    // anywhere on disk.
    const perAdapterOffsets = new Map<SessionAdapter, Map<string, number>>()
    for (const adapter of this.adapters) {
      perAdapterOffsets.set(adapter, new Map())
    }
    const orphanIds: string[] = []
    for (const [id, offset] of known.sessionOffsets) {
      let owner: SessionAdapter | undefined = this.ownerCache.get(id)
      if (!owner) {
        for (const adapter of this.adapters) {
          if (await adapter.claimsSessionId(id)) {
            owner = adapter
            this.ownerCache.set(id, adapter)
            break
          }
        }
      }
      if (owner) {
        perAdapterOffsets.get(owner)!.set(id, offset)
      } else {
        orphanIds.push(id)
      }
    }
    removedSessions.push(...orphanIds)

    // Each adapter sees only its own slice of `known.sessionOffsets`. Removals
    // are taken at face value and unioned (no intersection across adapters).
    for (const adapter of this.adapters) {
      const filteredOffsets = perAdapterOffsets.get(adapter)!
      const filteredKnown: IndexState = {
        sessionOffsets: filteredOffsets,
        lastSyncAt: known.lastSyncAt,
      }
      const result = await adapter.checkFreshness(filteredKnown)
      for (const id of result.newSessions) {
        this.ownerCache.set(id, adapter)
        newSessions.push(id)
      }
      for (const id of result.changedSessions) {
        this.ownerCache.set(id, adapter)
        changedSessions.push(id)
      }
      for (const id of result.removedSessions) {
        // Owner is gone — drop from cache so future probes re-resolve.
        this.ownerCache.delete(id)
        removedSessions.push(id)
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
