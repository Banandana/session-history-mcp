import 'reflect-metadata'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { IndexManager } from './index-manager'
import { ContextAuditor } from './context-auditor'

describe('ContextAuditor', () => {
  let tempDir: string
  let db: Database.Database
  let auditor: ContextAuditor

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'context-auditor-test-'))
    db = new Database(join(tempDir, 'test.db'))
    db.pragma('foreign_keys = ON')
    db.pragma('journal_mode = WAL')
    const indexManager = new (IndexManager as any)(db)
    indexManager.ensureSchema()

    const ins = db.prepare(`
      INSERT INTO sessions (id, source, project_slug, started_at, total_tokens, total_turns,
        cost_usd, total_cache_read_tokens, total_cache_creation_tokens, models_used)
      VALUES (?, 'claude-code', ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    ins.run('s1', 'proj-a', '2026-04-01T10:00:00Z', 100000, 50, 2.50, 60000, 10000, '["claude-sonnet-4-6"]')
    ins.run('s2', 'proj-a', '2026-04-02T10:00:00Z', 50000, 30, 1.00, 5000, 2000, '["claude-opus-4-6"]')
    ins.run('s3', 'proj-b', '2026-04-03T10:00:00Z', 200000, 100, 5.00, 180000, 5000, '["claude-sonnet-4-6"]')

    const insMsg = db.prepare(`
      INSERT INTO messages (id, session_id, role, type, timestamp, token_count, is_error, is_correction, has_tool_use, tool_names,
        cache_creation_tokens, cache_read_tokens)
      VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, 0, 0)
    `)
    insMsg.run('m1', 's1', 'user', 'user', '2026-04-01T10:01:00Z', 5000, 1, '["Read"]')
    insMsg.run('m2', 's1', 'user', 'user', '2026-04-01T10:02:00Z', 8000, 1, '["Bash"]')
    insMsg.run('m3', 's1', 'user', 'user', '2026-04-01T10:03:00Z', 3000, 1, '["Read","Grep"]')
    insMsg.run('m4', 's1', 'assistant', 'assistant', '2026-04-01T10:01:30Z', 500, 1, '["Read"]')
    insMsg.run('m5', 's2', 'user', 'user', '2026-04-02T10:01:00Z', 2000, 1, '["Edit"]')
    insMsg.run('m6', 's3', 'user', 'user', '2026-04-03T10:01:00Z', 15000, 1, '["Read"]')

    const insCC = db.prepare(`
      INSERT INTO context_collapses (session_id, collapse_id, summary)
      VALUES (?, ?, ?)
    `)
    insCC.run('s3', 'cc1', 'First collapse')
    insCC.run('s3', 'cc2', 'Second collapse')
    insCC.run('s1', 'cc3', 'Only collapse')

    auditor = new ContextAuditor(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tempDir, { recursive: true })
  })

  describe('cost_breakdown', () => {
    it('returns aggregate cost summary', () => {
      const result = auditor.costBreakdown('summary', {}) as any
      expect(result.totalCost).toBeCloseTo(8.50)
      expect(result.sessionCount).toBe(3)
      expect(result.maxCostSession.id).toBe('s3')
    })

    it('filters by project', () => {
      const result = auditor.costBreakdown('summary', { filters: { projectSlug: 'proj-a' } }) as any
      expect(result.sessionCount).toBe(2)
      expect(result.totalCost).toBeCloseTo(3.50)
    })

    it('returns per-session detail in full mode', () => {
      const result = auditor.costBreakdown('full', {}) as any
      expect(result.sessions.length).toBe(3)
      expect(result.sessions[0].id).toBe('s3') // most expensive first
    })

    it('groups by day', () => {
      const result = auditor.costBreakdown('summary', { groupBy: 'day' }) as any
      expect(result.periods.length).toBe(3)
    })
  })
})
