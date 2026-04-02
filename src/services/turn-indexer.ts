import type Database from 'better-sqlite3'
import type { NormalizedMessage } from '../types'

const MAX_PREVIEW_LENGTH = 200

export class TurnIndexer {
  constructor(private readonly db: Database.Database) {}

  indexSession(sessionId: string, messages: readonly NormalizedMessage[]): void {
    this.db.prepare('DELETE FROM turn_events WHERE session_id = ?').run(sessionId)

    const insert = this.db.prepare(`
      INSERT INTO turn_events (session_id, turn_index, turn_id, role, timestamp, tool_names, is_error, is_correction, text_preview)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    const insertMany = this.db.transaction((msgs: readonly NormalizedMessage[]) => {
      for (let i = 0; i < msgs.length; i++) {
        const msg = msgs[i]
        const toolNames = msg.toolNames && msg.toolNames.length > 0
          ? JSON.stringify(msg.toolNames)
          : '[]'
        const textPreview = this.extractPreview(msg)

        insert.run(
          sessionId,
          i,
          msg.uuid,
          msg.role,
          msg.timestamp,
          toolNames,
          msg.isError ? 1 : 0,
          msg.isCorrection ? 1 : 0,
          textPreview,
        )
      }
    })

    insertMany(messages)

    this.db.prepare('UPDATE sessions SET turn_events_indexed = 1 WHERE id = ?').run(sessionId)
  }

  private extractPreview(msg: NormalizedMessage): string | null {
    for (const block of msg.contentBlocks) {
      if (block.type === 'text' && block.text) {
        return block.text.length > MAX_PREVIEW_LENGTH
          ? block.text.slice(0, MAX_PREVIEW_LENGTH)
          : block.text
      }
    }
    return null
  }
}
