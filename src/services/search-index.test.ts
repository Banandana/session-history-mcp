import 'reflect-metadata'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { IndexManager } from './index-manager'
import { SearchIndex } from './search-index'

describe('SearchIndex', () => {
  let tempDir: string
  let db: Database.Database
  let indexManager: IndexManager
  let searchIndex: SearchIndex

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'search-index-test-'))
    db = new Database(join(tempDir, 'test.db'))
    db.pragma('foreign_keys = ON')
    db.pragma('journal_mode = WAL')

    indexManager = new (IndexManager as any)(db)
    indexManager.ensureSchema()

    // Pre-populate with test data
    db.prepare(`INSERT INTO sessions (id, source, project_slug, started_at) VALUES (?, ?, ?, ?)`).run(
      'session-1', 'claude-code', 'project-alpha', '2026-03-28T10:00:00Z',
    )
    db.prepare(`INSERT INTO sessions (id, source, project_slug, started_at) VALUES (?, ?, ?, ?)`).run(
      'session-2', 'claude-code', 'project-beta', '2026-03-28T11:00:00Z',
    )

    // Insert messages
    const insertMsg = db.prepare(`
      INSERT INTO messages (id, session_id, role, type, timestamp, model, content_preview)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    const insertFts = db.prepare(`INSERT INTO messages_fts (rowid, search_text) VALUES (?, ?)`)

    insertMsg.run('msg-1', 'session-1', 'user', 'user', '2026-03-28T10:00:01Z', null, 'Build the authentication module')
    let row = db.prepare('SELECT rowid FROM messages WHERE id = ?').get('msg-1') as { rowid: number }
    insertFts.run(row.rowid, 'Build the authentication module')

    insertMsg.run('msg-2', 'session-1', 'assistant', 'assistant', '2026-03-28T10:00:05Z', 'claude-opus-4-6', 'I will build the auth module with JWT tokens')
    row = db.prepare('SELECT rowid FROM messages WHERE id = ?').get('msg-2') as { rowid: number }
    insertFts.run(row.rowid, 'I will build the auth module with JWT tokens')

    insertMsg.run('msg-3', 'session-2', 'user', 'user', '2026-03-28T11:00:01Z', null, 'Fix the database connection pooling')
    row = db.prepare('SELECT rowid FROM messages WHERE id = ?').get('msg-3') as { rowid: number }
    insertFts.run(row.rowid, 'Fix the database connection pooling')

    insertMsg.run('msg-4', 'session-2', 'assistant', 'assistant', '2026-03-28T11:00:05Z', 'claude-opus-4-6', 'I will optimize the database connection pool configuration')
    row = db.prepare('SELECT rowid FROM messages WHERE id = ?').get('msg-4') as { rowid: number }
    insertFts.run(row.rowid, 'I will optimize the database connection pool configuration')

    insertMsg.run('msg-5', 'session-1', 'user', 'user', '2026-03-28T10:05:00Z', null, 'Now add database migration support')
    row = db.prepare('SELECT rowid FROM messages WHERE id = ?').get('msg-5') as { rowid: number }
    insertFts.run(row.rowid, 'Now add database migration support')

    searchIndex = new SearchIndex(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tempDir, { recursive: true })
  })

  it('returns ranked search results', () => {
    const results = searchIndex.search('authentication')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].messageId).toBeDefined()
    expect(results[0].sessionId).toBe('session-1')
    expect(results[0].contentPreview).toContain('auth')
    expect(typeof results[0].rank).toBe('number')
  })

  it('searches across sessions', () => {
    const results = searchIndex.search('database')
    expect(results.length).toBeGreaterThanOrEqual(3)
    // Should find results in both sessions
    const sessionIds = new Set(results.map(r => r.sessionId))
    expect(sessionIds.has('session-1')).toBe(true)
    expect(sessionIds.has('session-2')).toBe(true)
  })

  it('filters by project slug', () => {
    const results = searchIndex.search('database', { projectSlug: 'project-beta' })
    expect(results.length).toBeGreaterThan(0)
    for (const r of results) {
      expect(r.projectSlug).toBe('project-beta')
    }
  })

  it('filters by session ID', () => {
    const results = searchIndex.search('database', { sessionId: 'session-1' })
    expect(results.length).toBeGreaterThan(0)
    for (const r of results) {
      expect(r.sessionId).toBe('session-1')
    }
  })

  it('filters by date range', () => {
    const results = searchIndex.search('database', {
      dateRange: { from: '2026-03-28T10:30:00Z', to: '2026-03-28T12:00:00Z' },
    })
    // Should only match session-2 messages (11:00+)
    expect(results.length).toBeGreaterThan(0)
    for (const r of results) {
      expect(r.sessionId).toBe('session-2')
    }
  })

  it('returns empty array for no matches', () => {
    const results = searchIndex.search('nonexistent_xyz_query')
    expect(results).toEqual([])
  })

  it('returns empty array for empty query', () => {
    const results = searchIndex.search('')
    expect(results).toEqual([])
    const results2 = searchIndex.search('   ')
    expect(results2).toEqual([])
  })

  it('supports limit and offset', () => {
    const allResults = searchIndex.search('database')
    const limited = searchIndex.search('database', { limit: 2 })
    const offsetResults = searchIndex.search('database', { limit: 2, offset: 1 })

    expect(limited.length).toBeLessThanOrEqual(2)
    if (allResults.length > 1) {
      expect(offsetResults[0].messageId).toBe(allResults[1].messageId)
    }
  })

  it('searchCount returns correct number', () => {
    const count = searchIndex.searchCount('database')
    const results = searchIndex.search('database')
    expect(count).toBe(results.length)
  })

  it('searchCount with project filter', () => {
    const count = searchIndex.searchCount('database', { projectSlug: 'project-beta' })
    expect(count).toBeGreaterThan(0)
    const totalCount = searchIndex.searchCount('database')
    expect(count).toBeLessThanOrEqual(totalCount)
  })

  it('searchCount returns 0 for empty query', () => {
    expect(searchIndex.searchCount('')).toBe(0)
  })

  it('returns projectSlug in results', () => {
    const results = searchIndex.search('authentication')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].projectSlug).toBe('project-alpha')
  })
})
