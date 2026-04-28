import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { IndexManager } from './index-manager'
import { ToolInvocationLogger } from './invocation-logger'
import { AuditHistoryService, type RawInvocationRecord } from './audit-history'
import type { AuditHistoryEntry } from '../types/invocation-log'

describe('AuditHistoryService', () => {
  let db: Database.Database
  let logger: ToolInvocationLogger
  let service: AuditHistoryService

  beforeEach(() => {
    db = new Database(':memory:')
    new IndexManager(db).ensureSchema()
    logger = new ToolInvocationLogger(db)
    service = new AuditHistoryService(db)
  })

  afterEach(() => {
    db.close()
  })

  function seed() {
    const now = Date.now()
    logger.record({
      toolName: 'analyze',
      rawParams: { metric: 'errors', project: 'proj-a' },
      status: 'ok',
      durationMs: 1, resultSize: 0,
      calledAt: now - 86_400_000 * 5,
    })
    logger.record({
      toolName: 'analyze',
      rawParams: { metric: 'corrections', project: 'proj-a' },
      status: 'ok',
      durationMs: 1, resultSize: 0,
      calledAt: now - 86_400_000 * 1,
    })
    logger.record({
      toolName: 'context_audit',
      rawParams: { metric: 'cache_analysis', project: 'proj-b' },
      status: 'ok',
      durationMs: 1, resultSize: 0,
      calledAt: now - 86_400_000 * 2,
    })
  }

  it('returns audits sorted by recent by default', () => {
    seed()
    const out = service.query() as AuditHistoryEntry[]
    expect(out).toHaveLength(3)
    // Most recent first: corrections (1d) > context_audit (2d) > errors (5d)
    expect(out[0].toolName).toBe('analyze')
    expect(out[0].paramsCanonical).toMatchObject({ metric: 'corrections' })
    expect(out[1].toolName).toBe('context_audit')
    expect(out[2].paramsCanonical).toMatchObject({ metric: 'errors' })
  })

  it('filters by project', () => {
    seed()
    const out = service.query({ project: 'proj-b' }) as AuditHistoryEntry[]
    expect(out).toHaveLength(1)
    expect(out[0].toolName).toBe('context_audit')
  })

  it('filters by toolName', () => {
    seed()
    const out = service.query({ toolName: 'analyze' }) as AuditHistoryEntry[]
    expect(out).toHaveLength(2)
    expect(out.every(e => e.toolName === 'analyze')).toBe(true)
  })

  it('sort=stale puts oldest first', () => {
    seed()
    const out = service.query({ sort: 'stale' }) as AuditHistoryEntry[]
    expect(out[0].paramsCanonical).toMatchObject({ metric: 'errors' })
  })

  it('attaches followUp with suggestedSince for tools that support it', () => {
    seed()
    const out = service.query({ toolName: 'analyze' }) as AuditHistoryEntry[]
    for (const e of out) {
      expect(e.followUp).toBeDefined()
      expect(e.followUp!.tool).toBe('analyze')
      expect(typeof e.followUp!.suggestedSince).toBe('string')
    }
  })

  it('mode=raw returns the unfiltered call log', () => {
    seed()
    // Add an errored call — should appear in raw, not in audits
    logger.record({
      toolName: 'analyze',
      rawParams: { metric: 'errors', project: 'proj-x' },
      status: 'error',
      durationMs: 1, resultSize: 0,
    })

    const audits = service.query({ project: 'proj-x' }) as AuditHistoryEntry[]
    expect(audits).toHaveLength(0)

    const raw = service.query({ mode: 'raw', project: 'proj-x' }) as RawInvocationRecord[]
    expect(raw).toHaveLength(1)
    expect(raw[0].status).toBe('error')
  })

  it('recentForProject excludes denylisted tools', () => {
    seed()
    // Add a list_projects call — should be in raw log but not in recentAudits
    logger.record({
      toolName: 'list_projects',
      rawParams: {},
      status: 'ok',
      durationMs: 1, resultSize: 0,
    })

    const recent = service.recentForProject('proj-a', 10)
    expect(recent.every(e => e.toolName !== 'list_projects')).toBe(true)
    // Also confirm we got the proj-a audits
    expect(recent).toHaveLength(2)
  })

  it('recentForProject filters by project', () => {
    seed()
    const recent = service.recentForProject('proj-b', 10)
    expect(recent).toHaveLength(1)
    expect(recent[0].toolName).toBe('context_audit')
  })

  it('since filter excludes audits older than threshold', () => {
    seed()
    const since = new Date(Date.now() - 86_400_000 * 3).toISOString()
    const out = service.query({ since }) as AuditHistoryEntry[]
    // Should include corrections (1d) and context_audit (2d), exclude errors (5d)
    expect(out.map(e => `${e.toolName}:${(e.paramsCanonical as any).metric}`).sort()).toEqual([
      'analyze:corrections',
      'context_audit:cache_analysis',
    ])
  })

  it('staleSince filter returns only old audits', () => {
    seed()
    const staleSince = new Date(Date.now() - 86_400_000 * 3).toISOString()
    const out = service.query({ staleSince }) as AuditHistoryEntry[]
    expect(out).toHaveLength(1)
    expect((out[0].paramsCanonical as any).metric).toBe('errors')
  })
})
