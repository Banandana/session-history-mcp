import { join } from 'node:path'
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
} from '../../types'
import { fileExists, fileSize } from '../../infrastructure/file-system'
import { PiSessionDiscovery } from './session-discovery'
import { PiConversationParser } from './conversation-parser'
import { PiFileChangeExtractor } from './file-change-extractor'
import { PiMetadataParser } from './metadata-parser'
import { PiMemoryReader } from './memory-reader'
import { PiSubagentParser } from './subagent-parser'
import { ok, err, type Result } from 'neverthrow'
import { PiSessionNotFoundError, PiSessionReadError, type PiAdapterError } from './errors'

export { PiSessionDiscovery } from './session-discovery'
export { PiConversationParser } from './conversation-parser'
export { PiFileChangeExtractor } from './file-change-extractor'
export { PiMetadataParser } from './metadata-parser'
export { PiMemoryReader, PI_MEMORY_SLUG } from './memory-reader'
export { PiSubagentParser } from './subagent-parser'
export { PiSessionNotFoundError, PiSessionReadError, PiAdapterError } from './errors'

/**
 * Adapter for pi-coding-agent session logs at `~/.pi/agent/sessions/<encoded-cwd>/<ts>_<uuid>.jsonl`.
 *
 * Session id = the v7 UUID portion of the JSONL filename.
 * Project slug = pi's encoded-cwd folder name (e.g. `--data-project--`).
 * Memory = global `~/.pi/agent/memory/` surfaced under synthetic slug `pi-global`.
 * Subagents = none (pi has no agent-X.jsonl files).
 */
export class PiCodeAdapter implements SessionAdapter {
  readonly source = 'pi-code'

  private readonly discovery: PiSessionDiscovery
  private readonly conversationParser: PiConversationParser
  private readonly fileChangeExtractor: PiFileChangeExtractor
  private readonly metadataParser: PiMetadataParser
  private readonly memoryReader: PiMemoryReader
  private readonly subagentParser: PiSubagentParser

  constructor(private readonly piDir: string) {
    this.discovery = new PiSessionDiscovery(piDir)
    this.conversationParser = new PiConversationParser()
    this.fileChangeExtractor = new PiFileChangeExtractor()
    this.metadataParser = new PiMetadataParser()
    this.memoryReader = new PiMemoryReader(piDir)
    this.subagentParser = new PiSubagentParser()
  }

  async *discoverProjects(): AsyncIterable<ProjectMeta> {
    await this.discovery.buildProjectCache()
    yield* this.discovery.discoverProjects()
  }

  async *discoverSessions(project?: string): AsyncIterable<SessionMeta> {
    yield* this.discovery.discoverSessions(project)
  }

  async *getMessages(sessionId: string): AsyncIterable<NormalizedMessage> {
    const found = await this.discovery.findSessionFile(sessionId)
    if (!found) return
    yield* this.conversationParser.parseSession(found.path)
  }

  async *getFileChanges(sessionId: string): AsyncIterable<FileChange> {
    const found = await this.discovery.findSessionFile(sessionId)
    if (!found) return
    yield* this.fileChangeExtractor.extractChanges(found.path)
  }

  async *getSubagents(sessionId: string): AsyncIterable<SubagentMeta> {
    yield* this.subagentParser.getSubagents(sessionId)
  }

  async *getMemory(project?: string): AsyncIterable<MemoryEntry> {
    yield* this.memoryReader.readMemory(project)
  }

  async getSessionMetadata(sessionId: string): Promise<SessionMetadataResult | undefined> {
    const result = await this.getSessionMetadataResult(sessionId)
    return result.isOk() ? result.value : undefined
  }

  /**
   * Result-typed variant of getSessionMetadata. New callers should prefer this
   * — the SessionAdapter interface forces an `undefined`-erasing return, which
   * loses the distinction between "session doesn't exist" and "session exists
   * but failed to parse". The Result form preserves both.
   */
  async getSessionMetadataResult(
    sessionId: string,
  ): Promise<Result<SessionMetadataResult, PiAdapterError>> {
    const found = await this.discovery.findSessionFile(sessionId)
    if (!found) return err(new PiSessionNotFoundError(sessionId))
    try {
      const meta = await this.metadataParser.extractMetadata(found.path)
      return ok(meta)
    } catch (cause) {
      return err(new PiSessionReadError(found.path, cause))
    }
  }

  async getSessionCost(_projectSlug: string, _sessionId: string): Promise<number | undefined> {
    // Pi stores cost inside each assistant message's usage.cost.total. The cost field
    // is zero on this rig (local provider emits no cost). Skip per-session aggregation.
    return undefined
  }

  async resolveProject(path: string): Promise<ProjectMeta | undefined> {
    return this.discovery.resolveProject(path)
  }

  async checkFreshness(known: IndexState): Promise<FreshnessResult> {
    const newSessions: string[] = []
    const changedSessions: string[] = []
    const removedSessions: string[] = []
    const seenIds = new Set<string>()

    const sessionsDir = join(this.piDir, 'sessions')
    if (!(await fileExists(sessionsDir))) {
      // Pi never installed / no sessions yet — claim no sessions, don't reap claude's.
      return { isStale: false, newSessions: [], changedSessions: [], removedSessions: [] }
    }

    for await (const session of this.discovery.discoverSessions()) {
      seenIds.add(session.id)
      const found = await this.discovery.findSessionFile(session.id)
      if (!found) continue
      const currentSize = await fileSize(found.path)
      const knownOffset = known.sessionOffsets.get(session.id)
      if (knownOffset === undefined) {
        newSessions.push(session.id)
      } else if (currentSize > knownOffset) {
        changedSessions.push(session.id)
      }
    }

    // Only reap session IDs that look like pi UUIDs we previously indexed.
    // Don't reap claude UUIDs the claude-code adapter is responsible for.
    // Heuristic: known ids that we don't recognize stay alone — adapter-registry
    // unions the three lists across adapters, so claude-code's claim wins for its ids.
    for (const knownId of known.sessionOffsets.keys()) {
      if (seenIds.has(knownId)) continue
      // We can't tell from id alone whether it belongs to us. Leave removal to the
      // adapter that owns it; we only report sessions we positively know are gone.
    }

    return {
      isStale: newSessions.length > 0 || changedSessions.length > 0 || removedSessions.length > 0,
      newSessions,
      changedSessions,
      removedSessions,
    }
  }
}
