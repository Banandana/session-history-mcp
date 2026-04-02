import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { TurnIndexer } from './turn-indexer'
import type { NormalizedMessage } from '../types'

function makeMessage(overrides: Partial<NormalizedMessage> & { id: string }): NormalizedMessage {
  return {
    id: overrides.id,
    sessionId: 'session-1',
    role: overrides.role ?? 'assistant',
    timestamp: overrides.timestamp ?? '2026-01-01T00:00:00Z',
    contentBlocks: overrides.contentBlocks ?? [{ type: 'text', text: 'hello' }],
    isError: overrides.isError ?? false,
    isCorrection: overrides.isCorrection ?? false,
    hasThinking: false,
    uuid: overrides.id,
    toolNames: overrides.toolNames,
  }
}

describe('TurnIndexer', () => {
  let db: Database.Database
  let indexer: TurnIndexer

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, turn_events_indexed INTEGER DEFAULT 0);
      CREATE TABLE turn_events (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        turn_index INTEGER NOT NULL,
        turn_id TEXT NOT NULL,
        role TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        tool_names TEXT NOT NULL DEFAULT '[]',
        is_error INTEGER NOT NULL DEFAULT 0,
        is_correction INTEGER NOT NULL DEFAULT 0,
        text_preview TEXT,
        PRIMARY KEY (session_id, turn_index)
      );
    `)
    db.prepare("INSERT INTO sessions (id, source) VALUES ('session-1', 'claude-code')").run()
    indexer = new TurnIndexer(db)
  })

  afterEach(() => db.close())

  it('indexes messages as turn events', () => {
    const messages: NormalizedMessage[] = [
      makeMessage({ id: 'msg-1', role: 'user', contentBlocks: [{ type: 'text', text: 'fix the bug' }] }),
      makeMessage({
        id: 'msg-2',
        role: 'assistant',
        toolNames: ['Bash', 'Edit'],
        contentBlocks: [
          { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
          { type: 'tool_use', name: 'Edit', input: { file_path: '/src/app.ts' } },
        ],
      }),
    ]

    indexer.indexSession('session-1', messages)

    const rows = db.prepare('SELECT * FROM turn_events WHERE session_id = ? ORDER BY turn_index').all('session-1') as Array<{turn_index: number; role: string; text_preview: string; tool_names: string}>
    expect(rows).toHaveLength(2)
    expect(rows[0].turn_index).toBe(0)
    expect(rows[0].role).toBe('user')
    expect(rows[0].text_preview).toBe('fix the bug')
    expect(JSON.parse(rows[0].tool_names)).toEqual([])
    expect(rows[1].turn_index).toBe(1)
    expect(JSON.parse(rows[1].tool_names)).toEqual(['Bash', 'Edit'])
  })

  it('marks session as indexed', () => {
    indexer.indexSession('session-1', [])

    const row = db.prepare('SELECT turn_events_indexed FROM sessions WHERE id = ?').get('session-1') as { turn_events_indexed: number }
    expect(row.turn_events_indexed).toBe(1)
  })

  it('replaces existing turn events on re-index', () => {
    const messages = [makeMessage({ id: 'msg-1', role: 'user' })]
    indexer.indexSession('session-1', messages)
    indexer.indexSession('session-1', messages)

    const count = db.prepare('SELECT COUNT(*) as c FROM turn_events WHERE session_id = ?').get('session-1') as { c: number }
    expect(count.c).toBe(1)
  })

  it('stores error and correction flags', () => {
    const messages = [
      makeMessage({ id: 'msg-1', isError: true, isCorrection: false }),
      makeMessage({ id: 'msg-2', isError: false, isCorrection: true }),
    ]

    indexer.indexSession('session-1', messages)

    const rows = db.prepare('SELECT is_error, is_correction FROM turn_events WHERE session_id = ? ORDER BY turn_index').all('session-1') as Array<{is_error: number; is_correction: number}>
    expect(rows[0].is_error).toBe(1)
    expect(rows[0].is_correction).toBe(0)
    expect(rows[1].is_error).toBe(0)
    expect(rows[1].is_correction).toBe(1)
  })

  it('truncates text_preview to 200 chars', () => {
    const longText = 'a'.repeat(400)
    const messages = [
      makeMessage({ id: 'msg-1', contentBlocks: [{ type: 'text', text: longText }] }),
    ]

    indexer.indexSession('session-1', messages)

    const row = db.prepare('SELECT text_preview FROM turn_events WHERE session_id = ?').get('session-1') as { text_preview: string }
    expect(row.text_preview.length).toBe(200)
  })
})
