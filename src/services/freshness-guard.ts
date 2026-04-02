import type Database from 'better-sqlite3'
import type { AdapterRegistry } from './adapter-registry'
import type { IndexManager } from './index-manager'
import type { LocalLlmClient } from './local-llm-client'
import type { IndexState, NormalizedMessage, SessionMeta } from '../types'
import type { TurnIndexer } from './turn-indexer'
import { generateTopic } from './topic-generator'

function formatToolCounts(json: string): string {
  try {
    const counts = JSON.parse(json) as Record<string, number>
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, c]) => `${n}(${c})`).join(', ')
  } catch { return '' }
}

function formatFilesChanged(json: string): string {
  try {
    const files = JSON.parse(json) as Array<{ path: string; op: string }>
    return files.slice(0, 5).map(f => `${f.path} (${f.op})`).join(', ')
  } catch { return '' }
}

export class FreshnessGuard {
  private readonly db: Database.Database

  constructor(
    private readonly registry: AdapterRegistry,
    private readonly indexManager: IndexManager,
    private readonly claudeDir: string,
    db: Database.Database,
    private readonly llmClient?: LocalLlmClient,
    private readonly turnIndexer?: TurnIndexer,
  ) {
    this.db = db
  }

  async ensureFresh(): Promise<{
    syncDurationMs: number
    indexedAt: string
    sessionCount: number
    staleSessions: number
  }> {
    const start = Date.now()

    // 1. Ensure schema exists
    this.indexManager.ensureSchema()

    // 2. Build IndexState from current database
    const knownIds = this.indexManager.getKnownSessionIds()
    const offsets = new Map<string, number>()
    for (const id of knownIds) {
      offsets.set(id, this.indexManager.getSessionOffset(id))
    }
    const known: IndexState = {
      sessionOffsets: offsets,
      lastSyncAt: new Date().toISOString(),
    }

    // 3. Check freshness via adapter registry
    const result = await this.registry.checkFreshness(known)

    // 4. If stale, sync changes
    if (result.isStale) {
      await this.syncNewSessions(result.newSessions)
      await this.syncChangedSessions(result.changedSessions)
      this.removeDeletedSessions(result.removedSessions)
    }

    // 5. Fire-and-forget LLM summarization — must not block sync
    void this.generateSummaries().catch(() => { /* summarization failure is non-critical */ })

    // 6. Return metadata
    const sessionCount = this.indexManager.getKnownSessionIds().size
    return {
      syncDurationMs: Date.now() - start,
      indexedAt: new Date().toISOString(),
      sessionCount,
      staleSessions: 0,
    }
  }

  private async generateSummaries(): Promise<void> {
    if (!this.llmClient) return
    const available = await this.llmClient.isAvailable()
    if (!available) return

    // Find sessions needing summaries (max 5 per cycle)
    const rows = this.db.prepare(`
      SELECT id FROM sessions
      WHERE topic IS NOT NULL AND summary IS NULL
      LIMIT 5
    `).all() as Array<{ id: string }>

    for (const row of rows) {
      try {
        // Build context from stored metrics
        const session = this.db.prepare(
          'SELECT duration_minutes, total_turns, total_tokens, error_count, correction_count, tool_counts, files_changed FROM sessions WHERE id = ?'
        ).get(row.id) as Record<string, unknown>

        // Format metrics for LLM
        const metricsBlock = [
          `Session: ${session.duration_minutes ?? 0} min, ${session.total_turns ?? 0} turns, ${session.total_tokens ?? 0} tokens`,
          `Errors: ${session.error_count ?? 0}, Corrections: ${session.correction_count ?? 0}`,
          session.tool_counts ? `Tools: ${formatToolCounts(session.tool_counts as string)}` : null,
          session.files_changed ? `Files: ${formatFilesChanged(session.files_changed as string)}` : null,
        ].filter(Boolean).join('\n')

        const prompt = `${metricsBlock}\n\nSummarize this coding session in 2-3 sentences. Focus on what was accomplished and the outcome.`

        const summary = await this.llmClient.summarize(prompt)
        if (summary) {
          this.db.prepare('UPDATE sessions SET summary = ?, summary_generated_at = ? WHERE id = ?')
            .run(summary, new Date().toISOString(), row.id)
        }
      } catch {
        // Skip failed sessions — retry next cycle
      }
    }
  }

  private async syncNewSessions(sessionIds: readonly string[]): Promise<void> {
    // Discover session metadata for each new session
    const sessionIdSet = new Set(sessionIds)
    const sessionMetaMap = new Map<string, SessionMeta>()
    for await (const session of this.registry.discoverSessions()) {
      if (sessionIdSet.has(session.id)) {
        sessionMetaMap.set(session.id, session)
      }
      // Stop early once we've found all needed sessions
      if (sessionMetaMap.size === sessionIdSet.size) break
    }

    const insertSession = this.db.prepare(`
      INSERT OR REPLACE INTO sessions (id, source, project_slug, cwd, branch, started_at, model, total_tokens, total_turns, summary_text, byte_offset, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    const insertMessage = this.db.prepare(`
      INSERT OR REPLACE INTO messages (id, session_id, role, type, timestamp, model, token_count, has_tool_use, tool_names, is_error, is_correction, content_preview)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    const insertFts = this.db.prepare(`
      INSERT INTO messages_fts (rowid, content_preview) VALUES (?, ?)
    `)

    for (const sessionId of sessionIds) {
      const meta = sessionMetaMap.get(sessionId)

      // Insert session record
      insertSession.run(
        sessionId,
        meta?.source ?? 'claude-code',
        meta?.projectSlug ?? null,
        meta?.cwd ?? null,
        meta?.branch ?? null,
        meta?.startedAt ?? null,
        meta?.model ?? null,
        meta?.totalTokens ?? 0,
        meta?.totalTurns ?? 0,
        meta?.summaryText ?? null,
        0,
        new Date().toISOString(),
      )

      // Parse and index messages
      let byteOffset = 0
      const messages: NormalizedMessage[] = []
      for await (const msg of this.registry.getMessages(sessionId)) {
        messages.push(msg)
      }

      for (const msg of messages) {
        const contentPreview = this.extractContentPreview(msg)
        const tokenCount = msg.tokenUsage
          ? msg.tokenUsage.input_tokens + msg.tokenUsage.output_tokens
          : 0
        const hasToolUse = msg.toolNames && msg.toolNames.length > 0 ? 1 : 0
        const toolNames = msg.toolNames ? msg.toolNames.join(',') : null

        const result = insertMessage.run(
          msg.id,
          sessionId,
          msg.role,
          msg.role, // type same as role for simplicity
          msg.timestamp,
          msg.model ?? null,
          tokenCount,
          hasToolUse,
          toolNames,
          msg.isError ? 1 : 0,
          msg.isCorrection ? 1 : 0,
          contentPreview,
        )

        // Insert into FTS using the rowid returned by the INSERT
        if (contentPreview && result.lastInsertRowid) {
          insertFts.run(result.lastInsertRowid, contentPreview)
        }
      }

      // Aggregate token counts from messages back to session
      const tokenRow = this.db.prepare(
        'SELECT SUM(token_count) as total FROM messages WHERE session_id = ?'
      ).get(sessionId) as { total: number | null } | undefined
      if (tokenRow?.total) {
        this.db.prepare('UPDATE sessions SET total_tokens = ?, total_turns = ? WHERE id = ?')
          .run(tokenRow.total, messages.length, sessionId)
      }

      // Index file changes
      const insertFileChange = this.db.prepare(`
        INSERT OR IGNORE INTO file_changes (session_id, message_id, file_path, operation, timestamp)
        VALUES (?, ?, ?, ?, ?)
      `)
      for await (const change of this.registry.getFileChanges(sessionId)) {
        insertFileChange.run(
          sessionId,
          change.messageId ?? null,
          change.filePath,
          change.operation,
          change.timestamp,
        )
      }

      // Index subagents
      const insertSubagent = this.db.prepare(`
        INSERT OR IGNORE INTO subagents (id, session_id, agent_type, description, total_tokens, total_tools, duration_ms, model)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for await (const agent of this.registry.getSubagents(sessionId)) {
        insertSubagent.run(
          agent.id,
          sessionId,
          agent.agentType ?? null,
          agent.description ?? null,
          agent.totalTokens ?? null,
          agent.totalTools ?? null,
          agent.durationMs ?? null,
          agent.model ?? null,
        )
      }

      // Compute and store session metrics
      this.computeSessionMetrics(sessionId)
    }

    // Update offsets with real file sizes
    await this.updateFileOffsets(sessionIds)
  }

  private async syncChangedSessions(sessionIds: readonly string[]): Promise<void> {
    const insertMessage = this.db.prepare(`
      INSERT OR REPLACE INTO messages (id, session_id, role, type, timestamp, model, token_count, has_tool_use, tool_names, is_error, is_correction, content_preview)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    const insertFts = this.db.prepare(`
      INSERT INTO messages_fts (rowid, content_preview) VALUES (?, ?)
    `)

    for (const sessionId of sessionIds) {
      // Get messages (the adapter returns all messages; for changed sessions
      // we re-index all messages, using INSERT OR REPLACE to handle duplicates)
      const messages: NormalizedMessage[] = []
      for await (const msg of this.registry.getMessages(sessionId)) {
        messages.push(msg)
      }

      for (const msg of messages) {
        const contentPreview = this.extractContentPreview(msg)
        const tokenCount = msg.tokenUsage
          ? msg.tokenUsage.input_tokens + msg.tokenUsage.output_tokens
          : 0
        const hasToolUse = msg.toolNames && msg.toolNames.length > 0 ? 1 : 0
        const toolNames = msg.toolNames ? msg.toolNames.join(',') : null

        insertMessage.run(
          msg.id,
          sessionId,
          msg.role,
          msg.role,
          msg.timestamp,
          msg.model ?? null,
          tokenCount,
          hasToolUse,
          toolNames,
          msg.isError ? 1 : 0,
          msg.isCorrection ? 1 : 0,
          contentPreview,
        )

        if (contentPreview) {
          const row = this.db.prepare('SELECT rowid FROM messages WHERE id = ?').get(msg.id) as { rowid: number } | undefined
          if (row) {
            this.db.prepare('INSERT OR REPLACE INTO messages_fts (rowid, content_preview) VALUES (?, ?)').run(row.rowid, contentPreview)
          }
        }
      }

      // Aggregate token counts
      const tokenRow = this.db.prepare(
        'SELECT SUM(token_count) as total FROM messages WHERE session_id = ?'
      ).get(sessionId) as { total: number | null } | undefined
      if (tokenRow?.total) {
        this.db.prepare('UPDATE sessions SET total_tokens = ?, total_turns = ? WHERE id = ?')
          .run(tokenRow.total, messages.length, sessionId)
      }

      // Re-index file changes
      this.db.prepare('DELETE FROM file_changes WHERE session_id = ?').run(sessionId)
      const insertFileChange = this.db.prepare(`
        INSERT OR IGNORE INTO file_changes (session_id, message_id, file_path, operation, timestamp)
        VALUES (?, ?, ?, ?, ?)
      `)
      for await (const change of this.registry.getFileChanges(sessionId)) {
        insertFileChange.run(
          sessionId,
          change.messageId ?? null,
          change.filePath,
          change.operation,
          change.timestamp,
        )
      }

      // Re-index subagents
      this.db.prepare('DELETE FROM subagents WHERE session_id = ?').run(sessionId)
      const insertSubagent = this.db.prepare(`
        INSERT OR IGNORE INTO subagents (id, session_id, agent_type, description, total_tokens, total_tools, duration_ms, model)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for await (const agent of this.registry.getSubagents(sessionId)) {
        insertSubagent.run(
          agent.id,
          sessionId,
          agent.agentType ?? null,
          agent.description ?? null,
          agent.totalTokens ?? null,
          agent.totalTools ?? null,
          agent.durationMs ?? null,
          agent.model ?? null,
        )
      }

      // Compute and store session metrics
      this.computeSessionMetrics(sessionId)

      // Index turn events for structured queries
      this.turnIndexer?.indexSession(sessionId, messages)
    }

    await this.updateFileOffsets(sessionIds)
  }

  private removeDeletedSessions(sessionIds: readonly string[]): void {
    const deleteMessages = this.db.prepare('DELETE FROM messages WHERE session_id = ?')
    const deleteSession = this.db.prepare('DELETE FROM sessions WHERE id = ?')
    const deleteFileChanges = this.db.prepare('DELETE FROM file_changes WHERE session_id = ?')
    const deleteSubagents = this.db.prepare('DELETE FROM subagents WHERE session_id = ?')

    for (const sessionId of sessionIds) {
      // Delete FTS entries for messages in this session
      const messageRows = this.db.prepare(
        'SELECT rowid FROM messages WHERE session_id = ?'
      ).all(sessionId) as { rowid: number }[]
      for (const row of messageRows) {
        this.db.prepare('DELETE FROM messages_fts WHERE rowid = ?').run(row.rowid)
      }

      deleteMessages.run(sessionId)
      deleteFileChanges.run(sessionId)
      deleteSubagents.run(sessionId)
      deleteSession.run(sessionId)
    }
  }

  private computeSessionMetrics(sessionId: string): void {
    // Get started_at from session row
    const sessionRow = this.db.prepare(
      'SELECT started_at FROM sessions WHERE id = ?'
    ).get(sessionId) as { started_at: string | null } | undefined
    const startedAt = sessionRow?.started_at ?? null

    // Message counts
    const msgStats = this.db.prepare(`
      SELECT
        COUNT(*) as message_count,
        MAX(timestamp) as max_timestamp,
        SUM(CASE WHEN is_error = 1 THEN 1 ELSE 0 END) as error_count,
        SUM(CASE WHEN is_correction = 1 THEN 1 ELSE 0 END) as correction_count
      FROM messages WHERE session_id = ?
    `).get(sessionId) as {
      message_count: number
      max_timestamp: string | null
      error_count: number
      correction_count: number
    }

    const messageCount = msgStats.message_count
    const endedAt = messageCount > 0 ? msgStats.max_timestamp : startedAt
    const durationMinutes = messageCount > 0 && startedAt && endedAt
      ? Math.round((new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 60000)
      : 0

    // Subagent count
    const saRow = this.db.prepare(
      'SELECT COUNT(*) as cnt FROM subagents WHERE session_id = ?'
    ).get(sessionId) as { cnt: number }

    // Tool counts — aggregate from messages.tool_names (comma-separated)
    const toolRows = this.db.prepare(
      'SELECT tool_names FROM messages WHERE session_id = ? AND tool_names IS NOT NULL AND tool_names != \'\''
    ).all(sessionId) as { tool_names: string }[]

    const toolCounts: Record<string, number> = {}
    for (const row of toolRows) {
      for (const name of row.tool_names.split(',')) {
        const trimmed = name.trim()
        if (trimmed) {
          toolCounts[trimmed] = (toolCounts[trimmed] ?? 0) + 1
        }
      }
    }

    // Files changed — distinct (file_path, operation)
    const fcRows = this.db.prepare(
      'SELECT DISTINCT file_path, operation FROM file_changes WHERE session_id = ?'
    ).all(sessionId) as { file_path: string; operation: string }[]

    const filesChanged = fcRows.map(r => ({ path: r.file_path, op: r.operation }))

    // First several user messages for topic generation — topic generator
    // skips non-intent messages (slash commands, system injections)
    const userMsgRows = this.db.prepare(
      "SELECT content_preview FROM messages WHERE session_id = ? AND role = 'user' AND content_preview != '' AND has_tool_use = 0 ORDER BY timestamp ASC LIMIT 5"
    ).all(sessionId) as Array<{ content_preview: string | null }>

    const candidates = userMsgRows
      .map(r => r.content_preview)
      .filter((t): t is string => t != null)

    const topic = generateTopic({
      userMessages: candidates,
      toolCounts,
      errorCount: msgStats.error_count,
    })

    // Update session row
    this.db.prepare(`
      UPDATE sessions SET
        ended_at = ?,
        duration_minutes = ?,
        message_count = ?,
        error_count = ?,
        correction_count = ?,
        subagent_count = ?,
        tool_counts = ?,
        files_changed = ?,
        topic = ?
      WHERE id = ?
    `).run(
      endedAt,
      durationMinutes,
      messageCount,
      msgStats.error_count,
      msgStats.correction_count,
      saRow.cnt,
      JSON.stringify(toolCounts),
      JSON.stringify(filesChanged),
      topic,
      sessionId,
    )
  }

  private extractContentPreview(msg: NormalizedMessage): string {
    for (const block of msg.contentBlocks) {
      if (block.type === 'text' && block.text) {
        return block.text.slice(0, 200)
      }
    }
    return ''
  }

  private async updateFileOffsets(sessionIds: readonly string[]): Promise<void> {
    const { fileSize, fileExists } = await import('../infrastructure/file-system')
    const { join } = await import('node:path')
    const { listDirectories } = await import('../infrastructure/file-system')

    const projectsDir = join(this.claudeDir, 'projects')
    if (!(await fileExists(projectsDir))) return

    const slugs = await listDirectories(projectsDir)

    for (const sessionId of sessionIds) {
      for (const slug of slugs) {
        const candidate = join(projectsDir, slug, `${sessionId}.jsonl`)
        if (await fileExists(candidate)) {
          const size = await fileSize(candidate)
          this.indexManager.updateSessionOffset(sessionId, size)
          break
        }
      }
    }
  }
}
