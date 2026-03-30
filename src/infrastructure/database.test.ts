import 'reflect-metadata'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DatabaseConnection } from './database'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('DatabaseConnection', () => {
  let tempDir: string
  let db: DatabaseConnection

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'session-mcp-test-'))
    db = new (DatabaseConnection as any)()
    ;(db as any).claudeDir = tempDir
  })

  afterEach(() => {
    db.close()
    rmSync(tempDir, { recursive: true })
  })

  it('creates database with WAL mode', () => {
    const conn = db.get()
    const mode = conn.pragma('journal_mode', { simple: true })
    expect(mode).toBe('wal')
  })

  it('returns same connection on subsequent calls', () => {
    expect(db.get()).toBe(db.get())
  })

  it('creates new connection after close', () => {
    const first = db.get()
    db.close()
    const second = db.get()
    expect(second).not.toBe(first)
  })
})
