# Context Usage Auditing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add first-class context usage auditing to the session-history MCP via a new `context_audit` tool and enhancements to `list_sessions` and `get_session`.

**Architecture:** New `ContextAuditor` service (DI-managed, database-dependent) with one method per metric. Single `context-audit.ts` tool file delegates to the service. Existing tools get new parameters/output fields. All queries use existing schema (no migrations).

**Tech Stack:** TypeScript, better-sqlite3, tsyringe DI, Zod validation, vitest

**Spec:** `docs/superpowers/specs/2026-04-06-context-usage-auditing-design.md`

---

## File Structure

### New Files
| File | Responsibility |
|------|---------------|
| `src/types/context-audit.ts` | Types for context audit params, filter options, and result shapes |
| `src/services/context-auditor.ts` | SQL queries and metric computation (one method per metric) |
| `src/services/context-auditor.test.ts` | Unit tests for all 6 metrics at both detail levels |
| `src/tools/context-audit.ts` | MCP tool registration, Zod schema, delegates to ContextAuditor |

### Modified Files
| File | Changes |
|------|---------|
| `src/container/tokens.ts` | Add `ContextAuditor` token |
| `src/container/modules.ts` | Register `ContextAuditor` service |
| `src/tools/list-sessions.ts` | Add filters (minTokens, maxTokens, minCost, maxCost, minCacheHitRatio, maxCacheHitRatio), sorts (cost, cache_efficiency), output fields (costUsd, cacheTokens, contextCollapseCount) |
| `src/tools/get-session.ts` | Add cacheTokens.hitRatio, tokenAccumulation at metadata level; contextCollapses array and tokenCurve at full level |
| `src/tools/index.ts` | Add `registerContextAudit` import and call |

---

## Task 1: Context Audit Types

**Files:**
- Create: `src/types/context-audit.ts`
- Modify: `src/types/index.ts` (add barrel export)

- [ ] **Step 1: Create the types file**

```typescript
// src/types/context-audit.ts
import type { DateRange } from './common'

export type ContextAuditMetric =
  | 'cost_breakdown'
  | 'token_attribution'
  | 'context_utilization'
  | 'cache_analysis'
  | 'collapse_analysis'
  | 'session_profile'

export type ContextAuditDetail = 'summary' | 'full'
export type TemporalGrouping = 'day' | 'week' | 'month'

export interface ContextAuditFilters {
  readonly projectSlug?: string
  readonly dateRange?: DateRange
  readonly minTokens?: number
  readonly maxTokens?: number
  readonly minCost?: number
  readonly maxCost?: number
  readonly minCacheHitRatio?: number
  readonly maxCacheHitRatio?: number
  readonly modelFilter?: string
}

export interface ContextAuditOptions {
  readonly metric: ContextAuditMetric
  readonly detail: ContextAuditDetail
  readonly groupBy?: TemporalGrouping
  readonly filters?: ContextAuditFilters
  readonly limit?: number
}

// Result types per metric

export interface SessionRef {
  readonly id: string
  readonly topic: string | null
  readonly costUsd: number | null
}

export interface CostBreakdownSummary {
  readonly totalCost: number
  readonly avgCost: number
  readonly sessionCount: number
  readonly minCostSession: SessionRef | null
  readonly maxCostSession: SessionRef | null
  readonly periods?: readonly CostPeriod[]
}

export interface CostPeriod {
  readonly period: string
  readonly totalCost: number
  readonly avgCost: number
  readonly sessionCount: number
}

export interface CostBreakdownFull {
  readonly sessions: readonly CostSessionDetail[]
}

export interface CostSessionDetail {
  readonly id: string
  readonly topic: string | null
  readonly startedAt: string | null
  readonly costUsd: number | null
  readonly totalTokens: number
  readonly cacheTokens: { readonly creation: number; readonly read: number }
}

export interface ToolAttribution {
  readonly toolName: string
  readonly totalTokens: number
  readonly messageCount: number
  readonly pctOfTotal: number
}

export interface TokenAttributionSummary {
  readonly tools: readonly ToolAttribution[]
  readonly totalToolResultTokens: number
}

export interface TokenAttributionFull {
  readonly sessions: readonly TokenAttributionSession[]
}

export interface TokenAttributionSession {
  readonly sessionId: string
  readonly topic: string | null
  readonly tools: readonly { readonly toolName: string; readonly resultTokens: number; readonly callTokens: number }[]
}

export interface ContextUtilizationSummary {
  readonly avgTotalTokens: number
  readonly medianTotalTokens: number
  readonly maxTotalTokens: number
  readonly avgPeakMessageTokens: number
  readonly sessionsWithCollapses: { readonly count: number; readonly percentage: number }
  readonly periods?: readonly { readonly period: string; readonly avgTotalTokens: number; readonly sessionCount: number; readonly collapseRate: number }[]
}

export interface ContextUtilizationFull {
  readonly sessions: readonly {
    readonly id: string
    readonly topic: string | null
    readonly totalTokens: number
    readonly peakMessageTokens: number
    readonly collapseCount: number
    readonly totalTurns: number
  }[]
}

export interface CacheAnalysisSummary {
  readonly overallHitRatio: number
  readonly avgHitRatio: number
  readonly totalCacheCreation: number
  readonly totalCacheRead: number
  readonly sessionCount: number
  readonly periods?: readonly { readonly period: string; readonly overallHitRatio: number; readonly avgHitRatio: number; readonly totalCacheCreation: number; readonly totalCacheRead: number }[]
}

export interface CacheAnalysisFull {
  readonly sessions: readonly {
    readonly id: string
    readonly topic: string | null
    readonly cacheHitRatio: number
    readonly cacheCreationTokens: number
    readonly cacheReadTokens: number
    readonly totalTokens: number
  }[]
}

export interface CollapseAnalysisSummary {
  readonly totalCollapses: number
  readonly avgCollapsesPerSession: number
  readonly sessionsWithCollapses: { readonly count: number; readonly percentage: number }
  readonly maxCollapseSession: SessionRef & { readonly collapseCount: number } | null
  readonly periods?: readonly { readonly period: string; readonly totalCollapses: number; readonly sessionCount: number; readonly avgPerSession: number }[]
}

export interface CollapseAnalysisFull {
  readonly sessions: readonly {
    readonly id: string
    readonly topic: string | null
    readonly totalTokens: number
    readonly collapses: readonly { readonly collapseId: string; readonly summary: string | null }[]
  }[]
}

export interface SessionProfileSummary {
  readonly totalCost: number
  readonly totalTokens: number
  readonly avgCacheHitRatio: number
  readonly totalCollapses: number
  readonly sessionCount: number
  readonly topExpensive: readonly SessionRef[]
  readonly topTokenHeavy: readonly (SessionRef & { readonly totalTokens: number })[]
  readonly topWorstCache: readonly (SessionRef & { readonly cacheHitRatio: number })[]
}

export interface SessionProfileFull {
  readonly sessions: readonly SessionProfileDetail[]
}

export interface SessionProfileDetail {
  readonly id: string
  readonly topic: string | null
  readonly startedAt: string | null
  readonly durationMinutes: number | null
  readonly costUsd: number | null
  readonly totalTokens: number
  readonly cacheTokens: { readonly creation: number; readonly read: number; readonly hitRatio: number }
  readonly collapseCount: number
  readonly totalTurns: number
  readonly peakMessageTokens: number
  readonly topTools: readonly { readonly toolName: string; readonly tokenCount: number }[]
  readonly modelsUsed: readonly string[]
}

export type ContextAuditResult =
  | CostBreakdownSummary | CostBreakdownFull
  | TokenAttributionSummary | TokenAttributionFull
  | ContextUtilizationSummary | ContextUtilizationFull
  | CacheAnalysisSummary | CacheAnalysisFull
  | CollapseAnalysisSummary | CollapseAnalysisFull
  | SessionProfileSummary | SessionProfileFull
```

- [ ] **Step 2: Add barrel export**

In `src/types/index.ts`, add:
```typescript
export * from './context-audit'
```

- [ ] **Step 3: Commit**

```bash
git add src/types/context-audit.ts src/types/index.ts
git commit -m "feat(types): add context audit result types"
```

---

## Task 2: ContextAuditor Service — SQL Filter Builder

**Files:**
- Create: `src/services/context-auditor.ts`

The service is large, so we build it incrementally. Start with the shared filter/groupBy SQL builder, then add metrics one at a time.

- [ ] **Step 1: Write the test for filter building**

Create `src/services/context-auditor.test.ts`:

```typescript
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

    // Seed test data: 3 sessions with varying cost, tokens, cache
    const ins = db.prepare(`
      INSERT INTO sessions (id, source, project_slug, started_at, total_tokens, total_turns,
        cost_usd, total_cache_read_tokens, total_cache_creation_tokens, models_used)
      VALUES (?, 'claude-code', ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    ins.run('s1', 'proj-a', '2026-04-01T10:00:00Z', 100000, 50, 2.50, 60000, 10000, '["claude-sonnet-4-6"]')
    ins.run('s2', 'proj-a', '2026-04-02T10:00:00Z', 50000, 30, 1.00, 5000, 2000, '["claude-opus-4-6"]')
    ins.run('s3', 'proj-b', '2026-04-03T10:00:00Z', 200000, 100, 5.00, 180000, 5000, '["claude-sonnet-4-6"]')

    // Seed messages with tool_names for attribution
    const insMsg = db.prepare(`
      INSERT INTO messages (id, session_id, role, type, timestamp, token_count, is_error, is_correction, has_tool_use, tool_names,
        cache_creation_tokens, cache_read_tokens)
      VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, 0, 0)
    `)
    // s1: user messages with tool results
    insMsg.run('m1', 's1', 'user', 'user', '2026-04-01T10:01:00Z', 5000, 1, '["Read"]')
    insMsg.run('m2', 's1', 'user', 'user', '2026-04-01T10:02:00Z', 8000, 1, '["Bash"]')
    insMsg.run('m3', 's1', 'user', 'user', '2026-04-01T10:03:00Z', 3000, 1, '["Read","Grep"]')
    // s1: assistant messages with tool calls
    insMsg.run('m4', 's1', 'assistant', 'assistant', '2026-04-01T10:01:30Z', 500, 1, '["Read"]')
    // s2: user messages
    insMsg.run('m5', 's2', 'user', 'user', '2026-04-02T10:01:00Z', 2000, 1, '["Edit"]')
    // s3: user messages
    insMsg.run('m6', 's3', 'user', 'user', '2026-04-03T10:01:00Z', 15000, 1, '["Read"]')

    // Seed context collapses
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
      expect(result.periods.length).toBe(3) // 3 different days
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/context-auditor.test.ts`
Expected: FAIL — `context-auditor` module not found

- [ ] **Step 3: Write the service skeleton with filter builder and cost_breakdown**

Create `src/services/context-auditor.ts`:

```typescript
import type Database from 'better-sqlite3'
import type {
  ContextAuditDetail,
  ContextAuditFilters,
  TemporalGrouping,
  CostBreakdownSummary,
  CostBreakdownFull,
  SessionRef,
  CostPeriod,
} from '../types/context-audit'

interface SqlFilter {
  readonly conditions: readonly string[]
  readonly params: readonly (string | number)[]
}

const TEMPORAL_FORMATS: Record<TemporalGrouping, string> = {
  day: '%Y-%m-%d',
  week: '%Y-W%W',
  month: '%Y-%m',
}

export class ContextAuditor {
  constructor(private readonly db: Database.Database) {}

  /** Build WHERE conditions + params from filters. Prefix is the table alias (e.g. 's'). */
  private buildSessionFilters(filters?: ContextAuditFilters, prefix = 's'): SqlFilter {
    const conditions: string[] = []
    const params: (string | number)[] = []

    if (filters?.projectSlug) {
      conditions.push(`${prefix}.project_slug = ?`)
      params.push(filters.projectSlug)
    }
    if (filters?.dateRange?.from) {
      conditions.push(`${prefix}.started_at >= ?`)
      params.push(filters.dateRange.from)
    }
    if (filters?.dateRange?.to) {
      conditions.push(`${prefix}.started_at <= ?`)
      params.push(filters.dateRange.to)
    }
    if (filters?.minTokens != null) {
      conditions.push(`${prefix}.total_tokens >= ?`)
      params.push(filters.minTokens)
    }
    if (filters?.maxTokens != null) {
      conditions.push(`${prefix}.total_tokens <= ?`)
      params.push(filters.maxTokens)
    }
    if (filters?.minCost != null) {
      conditions.push(`${prefix}.cost_usd >= ?`)
      params.push(filters.minCost)
    }
    if (filters?.maxCost != null) {
      conditions.push(`${prefix}.cost_usd <= ?`)
      params.push(filters.maxCost)
    }
    if (filters?.minCacheHitRatio != null) {
      conditions.push(
        `(CAST(COALESCE(${prefix}.total_cache_read_tokens, 0) AS REAL) / CASE WHEN ${prefix}.total_tokens = 0 THEN 1 ELSE ${prefix}.total_tokens END * 100) >= ?`
      )
      params.push(filters.minCacheHitRatio)
    }
    if (filters?.maxCacheHitRatio != null) {
      conditions.push(
        `(CAST(COALESCE(${prefix}.total_cache_read_tokens, 0) AS REAL) / CASE WHEN ${prefix}.total_tokens = 0 THEN 1 ELSE ${prefix}.total_tokens END * 100) <= ?`
      )
      params.push(filters.maxCacheHitRatio)
    }
    if (filters?.modelFilter) {
      conditions.push(
        `EXISTS (SELECT 1 FROM json_each(${prefix}.models_used) WHERE value = ?)`
      )
      params.push(filters.modelFilter)
    }

    return { conditions, params }
  }

  private whereClause(filter: SqlFilter): string {
    return filter.conditions.length > 0 ? `WHERE ${filter.conditions.join(' AND ')}` : ''
  }

  // ── cost_breakdown ──

  costBreakdown(
    detail: ContextAuditDetail,
    options: { filters?: ContextAuditFilters; groupBy?: TemporalGrouping; limit?: number }
  ): CostBreakdownSummary | CostBreakdownFull {
    const limit = options.limit ?? 20
    const filter = this.buildSessionFilters(options.filters)
    const where = this.whereClause(filter)

    if (detail === 'full') {
      return this.costBreakdownFull(where, filter.params, limit)
    }
    return this.costBreakdownSummary(where, filter.params, options.groupBy)
  }

  private costBreakdownSummary(
    where: string, params: readonly (string | number)[], groupBy?: TemporalGrouping
  ): CostBreakdownSummary {
    const agg = this.db.prepare(`
      SELECT SUM(cost_usd) as total_cost, AVG(cost_usd) as avg_cost, COUNT(*) as session_count
      FROM sessions s ${where}
    `).get(...params) as { total_cost: number | null; avg_cost: number | null; session_count: number }

    const minMax = this.getMinMaxCostSessions(where, params)

    let periods: CostPeriod[] | undefined
    if (groupBy) {
      const fmt = TEMPORAL_FORMATS[groupBy]
      periods = this.db.prepare(`
        SELECT strftime('${fmt}', s.started_at) as period,
               SUM(cost_usd) as total_cost, AVG(cost_usd) as avg_cost, COUNT(*) as session_count
        FROM sessions s ${where}
        GROUP BY period ORDER BY period
      `).all(...params) as CostPeriod[]
    }

    return {
      totalCost: agg.total_cost ?? 0,
      avgCost: agg.avg_cost ?? 0,
      sessionCount: agg.session_count,
      minCostSession: minMax.min,
      maxCostSession: minMax.max,
      ...(periods ? { periods } : {}),
    }
  }

  private getMinMaxCostSessions(
    where: string, params: readonly (string | number)[]
  ): { min: SessionRef | null; max: SessionRef | null } {
    const costFilter = where
      ? `${where} AND cost_usd IS NOT NULL`
      : 'WHERE cost_usd IS NOT NULL'

    const minRow = this.db.prepare(`
      SELECT id, topic, cost_usd FROM sessions s ${costFilter}
      ORDER BY cost_usd ASC LIMIT 1
    `).get(...params) as { id: string; topic: string | null; cost_usd: number } | undefined

    const maxRow = this.db.prepare(`
      SELECT id, topic, cost_usd FROM sessions s ${costFilter}
      ORDER BY cost_usd DESC LIMIT 1
    `).get(...params) as { id: string; topic: string | null; cost_usd: number } | undefined

    return {
      min: minRow ? { id: minRow.id, topic: minRow.topic, costUsd: minRow.cost_usd } : null,
      max: maxRow ? { id: maxRow.id, topic: maxRow.topic, costUsd: maxRow.cost_usd } : null,
    }
  }

  private costBreakdownFull(
    where: string, params: readonly (string | number)[], limit: number
  ): CostBreakdownFull {
    const rows = this.db.prepare(`
      SELECT id, topic, started_at, cost_usd, total_tokens,
             total_cache_creation_tokens, total_cache_read_tokens
      FROM sessions s ${where}
      ORDER BY cost_usd IS NULL, cost_usd DESC
      LIMIT ?
    `).all(...params, limit) as Array<{
      id: string; topic: string | null; started_at: string | null
      cost_usd: number | null; total_tokens: number
      total_cache_creation_tokens: number | null; total_cache_read_tokens: number | null
    }>

    return {
      sessions: rows.map(r => ({
        id: r.id,
        topic: r.topic,
        startedAt: r.started_at,
        costUsd: r.cost_usd,
        totalTokens: r.total_tokens,
        cacheTokens: {
          creation: r.total_cache_creation_tokens ?? 0,
          read: r.total_cache_read_tokens ?? 0,
        },
      })),
    }
  }
}
```

- [ ] **Step 4: Run cost_breakdown tests**

Run: `npx vitest run src/services/context-auditor.test.ts`
Expected: PASS for cost_breakdown tests

- [ ] **Step 5: Commit**

```bash
git add src/types/context-audit.ts src/types/index.ts src/services/context-auditor.ts src/services/context-auditor.test.ts
git commit -m "feat: add ContextAuditor service with cost_breakdown metric"
```

---

## Task 3: ContextAuditor — token_attribution Metric

**Files:**
- Modify: `src/services/context-auditor.ts`
- Modify: `src/services/context-auditor.test.ts`

- [ ] **Step 1: Add token_attribution tests**

Append to the describe block in `context-auditor.test.ts`:

```typescript
describe('token_attribution', () => {
  it('returns tools ranked by result token consumption', () => {
    const result = auditor.tokenAttribution('summary', {}) as any
    expect(result.tools.length).toBeGreaterThan(0)
    // Read appears in 3 messages (m1, m3, m6) with tokens 5000+3000+15000=23000
    const readTool = result.tools.find((t: any) => t.toolName === 'Read')
    expect(readTool).toBeDefined()
    expect(readTool.totalTokens).toBe(23000)
    // Each tool has pctOfTotal
    expect(readTool.pctOfTotal).toBeGreaterThan(0)
  })

  it('returns per-session breakdown in full mode', () => {
    const result = auditor.tokenAttribution('full', {}) as any
    expect(result.sessions.length).toBeGreaterThan(0)
    const s1 = result.sessions.find((s: any) => s.sessionId === 's1')
    expect(s1.tools.length).toBeGreaterThan(0)
  })

  it('filters by project', () => {
    const result = auditor.tokenAttribution('summary', { filters: { projectSlug: 'proj-b' } }) as any
    // Only s3 in proj-b, only Read tool
    expect(result.tools.length).toBe(1)
    expect(result.tools[0].toolName).toBe('Read')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/context-auditor.test.ts -t "token_attribution"`
Expected: FAIL — `tokenAttribution` is not a function

- [ ] **Step 3: Implement tokenAttribution in context-auditor.ts**

Add these methods to the `ContextAuditor` class:

```typescript
// ── token_attribution ──

tokenAttribution(
  detail: ContextAuditDetail,
  options: { filters?: ContextAuditFilters; limit?: number }
): TokenAttributionSummary | TokenAttributionFull {
  const limit = options.limit ?? 20
  const filter = this.buildSessionFilters(options.filters)
  const where = this.whereClause(filter)

  if (detail === 'full') {
    return this.tokenAttributionFull(where, filter.params, limit)
  }
  return this.tokenAttributionSummary(where, filter.params, limit)
}

private tokenAttributionSummary(
  where: string, params: readonly (string | number)[], limit: number
): TokenAttributionSummary {
  // Join messages with sessions, explode tool_names via json_each, filter to user role (tool results)
  const joinWhere = where
    ? where.replace(/\bs\./g, 's.') + ' AND m.tool_names IS NOT NULL AND m.role = \'user\''
    : 'WHERE m.tool_names IS NOT NULL AND m.role = \'user\''

  const rows = this.db.prepare(`
    SELECT tool_name.value as tool_name,
           SUM(m.token_count) as total_tokens,
           COUNT(*) as message_count
    FROM messages m
    JOIN sessions s ON m.session_id = s.id,
    json_each(m.tool_names) as tool_name
    ${joinWhere}
    GROUP BY tool_name.value
    ORDER BY total_tokens DESC
    LIMIT ?
  `).all(...params, limit) as Array<{ tool_name: string; total_tokens: number; message_count: number }>

  const grandTotal = this.db.prepare(`
    SELECT COALESCE(SUM(m.token_count), 0) as total
    FROM messages m
    JOIN sessions s ON m.session_id = s.id
    ${where ? where + ' AND' : 'WHERE'} m.tool_names IS NOT NULL AND m.role = 'user'
  `).get(...params) as { total: number }

  return {
    tools: rows.map(r => ({
      toolName: r.tool_name,
      totalTokens: r.total_tokens,
      messageCount: r.message_count,
      pctOfTotal: grandTotal.total > 0
        ? Math.round(r.total_tokens / grandTotal.total * 1000) / 10
        : 0,
    })),
    totalToolResultTokens: grandTotal.total,
  }
}

private tokenAttributionFull(
  where: string, params: readonly (string | number)[], limit: number
): TokenAttributionFull {
  // Get sessions matching filters
  const sessions = this.db.prepare(`
    SELECT id, topic FROM sessions s ${where}
    ORDER BY total_tokens DESC LIMIT ?
  `).all(...params, limit) as Array<{ id: string; topic: string | null }>

  const sessionIds = sessions.map(s => s.id)
  if (sessionIds.length === 0) return { sessions: [] }

  const placeholders = sessionIds.map(() => '?').join(',')

  // Get per-session tool breakdown (both result and call tokens)
  const toolRows = this.db.prepare(`
    SELECT m.session_id, tool_name.value as tool_name, m.role,
           SUM(m.token_count) as total_tokens
    FROM messages m, json_each(m.tool_names) as tool_name
    WHERE m.session_id IN (${placeholders})
      AND m.tool_names IS NOT NULL
    GROUP BY m.session_id, tool_name.value, m.role
  `).all(...sessionIds) as Array<{
    session_id: string; tool_name: string; role: string; total_tokens: number
  }>

  // Group by session
  const bySession = new Map<string, Map<string, { resultTokens: number; callTokens: number }>>()
  for (const row of toolRows) {
    if (!bySession.has(row.session_id)) bySession.set(row.session_id, new Map())
    const tools = bySession.get(row.session_id)!
    if (!tools.has(row.tool_name)) tools.set(row.tool_name, { resultTokens: 0, callTokens: 0 })
    const entry = tools.get(row.tool_name)!
    if (row.role === 'user') entry.resultTokens += row.total_tokens
    else entry.callTokens += row.total_tokens
  }

  return {
    sessions: sessions.map(s => ({
      sessionId: s.id,
      topic: s.topic,
      tools: Array.from(bySession.get(s.id)?.entries() ?? [])
        .map(([toolName, tokens]) => ({ toolName, ...tokens }))
        .sort((a, b) => b.resultTokens - a.resultTokens),
    })),
  }
}
```

Add the imports at the top:
```typescript
import type { TokenAttributionSummary, TokenAttributionFull } from '../types/context-audit'
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/services/context-auditor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/context-auditor.ts src/services/context-auditor.test.ts
git commit -m "feat: add token_attribution metric to ContextAuditor"
```

---

## Task 4: ContextAuditor — context_utilization, cache_analysis, collapse_analysis

**Files:**
- Modify: `src/services/context-auditor.ts`
- Modify: `src/services/context-auditor.test.ts`

These three metrics follow the same SQL pattern as cost_breakdown. Implement and test them together since each is relatively simple.

- [ ] **Step 1: Add tests for all three metrics**

Append to the describe block in `context-auditor.test.ts`:

```typescript
describe('context_utilization', () => {
  it('returns token accumulation stats', () => {
    const result = auditor.contextUtilization('summary', {}) as any
    expect(result.avgTotalTokens).toBeGreaterThan(0)
    expect(result.medianTotalTokens).toBeGreaterThan(0)
    expect(result.sessionsWithCollapses.count).toBe(2) // s1 and s3 have collapses
    expect(result.sessionsWithCollapses.percentage).toBeCloseTo(66.67, 0)
  })

  it('returns per-session data in full mode', () => {
    const result = auditor.contextUtilization('full', {}) as any
    expect(result.sessions.length).toBe(3)
    expect(result.sessions[0].id).toBe('s3') // most tokens first
    expect(result.sessions[0].collapseCount).toBe(2)
  })
})

describe('cache_analysis', () => {
  it('returns aggregate cache stats', () => {
    const result = auditor.cacheAnalysis('summary', {}) as any
    expect(result.overallHitRatio).toBeGreaterThan(0)
    expect(result.sessionCount).toBe(3)
    expect(result.totalCacheCreation).toBe(17000) // 10000+2000+5000
    expect(result.totalCacheRead).toBe(245000) // 60000+5000+180000
  })

  it('returns per-session in full mode sorted by worst ratio', () => {
    const result = auditor.cacheAnalysis('full', {}) as any
    expect(result.sessions.length).toBe(3)
    // s2 has worst ratio: 5000/50000 = 10%
    expect(result.sessions[0].id).toBe('s2')
  })
})

describe('collapse_analysis', () => {
  it('returns collapse frequency stats', () => {
    const result = auditor.collapseAnalysis('summary', {}) as any
    expect(result.totalCollapses).toBe(3) // cc1,cc2,cc3
    expect(result.sessionsWithCollapses.count).toBe(2) // s1 and s3
    expect(result.maxCollapseSession.id).toBe('s3')
    expect(result.maxCollapseSession.collapseCount).toBe(2)
  })

  it('returns per-session collapses in full mode', () => {
    const result = auditor.collapseAnalysis('full', {}) as any
    const s3 = result.sessions.find((s: any) => s.id === 's3')
    expect(s3.collapses.length).toBe(2)
    expect(s3.collapses[0].collapseId).toBe('cc1')
  })

  it('groups by day', () => {
    const result = auditor.collapseAnalysis('summary', { groupBy: 'day' }) as any
    expect(result.periods).toBeDefined()
    expect(result.periods.length).toBeGreaterThan(0)
  })
})

describe('groupBy for other metrics', () => {
  it('context_utilization groups by day', () => {
    const result = auditor.contextUtilization('summary', { groupBy: 'day' }) as any
    expect(result.periods).toBeDefined()
    expect(result.periods.length).toBe(3)
  })

  it('cache_analysis groups by day', () => {
    const result = auditor.cacheAnalysis('summary', { groupBy: 'day' }) as any
    expect(result.periods).toBeDefined()
    expect(result.periods.length).toBeGreaterThan(0)
  })
})

describe('edge cases', () => {
  it('handles session with zero tokens', () => {
    // Insert a zero-token session
    db.prepare(`
      INSERT INTO sessions (id, source, project_slug, started_at, total_tokens, total_turns,
        cost_usd, total_cache_read_tokens, total_cache_creation_tokens, models_used)
      VALUES (?, 'claude-code', 'proj-a', '2026-04-04T10:00:00Z', 0, 0, NULL, 0, 0, '[]')
    `).run('s-zero')

    // cache_analysis should not divide by zero
    const result = auditor.cacheAnalysis('full', {}) as any
    const zeroSession = result.sessions.find((s: any) => s.id === 's-zero')
    expect(zeroSession.cacheHitRatio).toBe(0)
  })

  it('handles empty result set', () => {
    const result = auditor.costBreakdown('summary', {
      filters: { projectSlug: 'nonexistent' }
    }) as any
    expect(result.sessionCount).toBe(0)
    expect(result.totalCost).toBe(0)
  })

  it('handles null cost_usd in cost_breakdown', () => {
    db.prepare(`
      INSERT INTO sessions (id, source, project_slug, started_at, total_tokens, total_turns, models_used)
      VALUES (?, 'claude-code', 'proj-a', '2026-04-04T10:00:00Z', 1000, 5, '[]')
    `).run('s-nocost')

    const result = auditor.costBreakdown('full', {}) as any
    const noCost = result.sessions.find((s: any) => s.id === 's-nocost')
    expect(noCost.costUsd).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/services/context-auditor.test.ts`
Expected: FAIL — methods not found

- [ ] **Step 3: Implement all three metrics**

Add to `ContextAuditor` class. Add corresponding type imports at the top of the file.

**context_utilization:**

```typescript
// ── context_utilization ──

contextUtilization(
  detail: ContextAuditDetail,
  options: { filters?: ContextAuditFilters; groupBy?: TemporalGrouping; limit?: number }
): ContextUtilizationSummary | ContextUtilizationFull {
  const limit = options.limit ?? 20
  const filter = this.buildSessionFilters(options.filters)
  const where = this.whereClause(filter)

  if (detail === 'full') {
    return this.contextUtilizationFull(where, filter.params, limit)
  }
  return this.contextUtilizationSummary(where, filter.params, options.groupBy)
}

private contextUtilizationSummary(
  where: string, params: readonly (string | number)[], groupBy?: TemporalGrouping
): ContextUtilizationSummary {
  const agg = this.db.prepare(`
    SELECT AVG(s.total_tokens) as avg_total, MAX(s.total_tokens) as max_total,
           COUNT(*) as session_count,
           SUM(CASE WHEN cc.cnt > 0 THEN 1 ELSE 0 END) as sessions_with_collapses
    FROM sessions s
    LEFT JOIN (SELECT session_id, COUNT(*) as cnt FROM context_collapses GROUP BY session_id) cc
      ON cc.session_id = s.id
    ${where}
  `).get(...params) as {
    avg_total: number | null; max_total: number | null
    session_count: number; sessions_with_collapses: number
  }

  // Median: fetch all total_tokens sorted, pick middle
  const allTokens = this.db.prepare(`
    SELECT total_tokens FROM sessions s ${where} ORDER BY total_tokens
  `).all(...params) as Array<{ total_tokens: number }>
  const median = allTokens.length > 0
    ? allTokens[Math.floor(allTokens.length / 2)].total_tokens
    : 0

  // Average peak message tokens across sessions
  const peakAvg = this.db.prepare(`
    SELECT AVG(peak) as avg_peak FROM (
      SELECT MAX(m.token_count) as peak
      FROM messages m
      JOIN sessions s ON m.session_id = s.id
      ${where}
      GROUP BY m.session_id
    )
  `).get(...params) as { avg_peak: number | null }

  let periods: ContextUtilizationSummary['periods']
  if (groupBy) {
    const fmt = TEMPORAL_FORMATS[groupBy]
    periods = this.db.prepare(`
      SELECT strftime('${fmt}', s.started_at) as period,
             AVG(s.total_tokens) as avgTotalTokens, COUNT(*) as sessionCount,
             CAST(SUM(CASE WHEN cc.cnt > 0 THEN 1 ELSE 0 END) AS REAL) / MAX(COUNT(*), 1) * 100 as collapseRate
      FROM sessions s
      LEFT JOIN (SELECT session_id, COUNT(*) as cnt FROM context_collapses GROUP BY session_id) cc
        ON cc.session_id = s.id
      ${where}
      GROUP BY period ORDER BY period
    `).all(...params) as any[]
  }

  return {
    avgTotalTokens: agg.avg_total ?? 0,
    medianTotalTokens: median,
    maxTotalTokens: agg.max_total ?? 0,
    avgPeakMessageTokens: peakAvg.avg_peak ?? 0,
    sessionsWithCollapses: {
      count: agg.sessions_with_collapses,
      percentage: agg.session_count > 0
        ? Math.round(agg.sessions_with_collapses / agg.session_count * 1000) / 10
        : 0,
    },
    ...(periods ? { periods } : {}),
  }
}

private contextUtilizationFull(
  where: string, params: readonly (string | number)[], limit: number
): ContextUtilizationFull {
  const rows = this.db.prepare(`
    SELECT s.id, s.topic, s.total_tokens, s.total_turns,
           (SELECT MAX(m.token_count) FROM messages m WHERE m.session_id = s.id) as peak_msg,
           (SELECT COUNT(*) FROM context_collapses cc WHERE cc.session_id = s.id) as collapse_count
    FROM sessions s ${where}
    ORDER BY s.total_tokens DESC LIMIT ?
  `).all(...params, limit) as Array<{
    id: string; topic: string | null; total_tokens: number; total_turns: number
    peak_msg: number | null; collapse_count: number
  }>

  return {
    sessions: rows.map(r => ({
      id: r.id,
      topic: r.topic,
      totalTokens: r.total_tokens,
      peakMessageTokens: r.peak_msg ?? 0,
      collapseCount: r.collapse_count,
      totalTurns: r.total_turns,
    })),
  }
}
```

**cache_analysis:**

```typescript
// ── cache_analysis ──

cacheAnalysis(
  detail: ContextAuditDetail,
  options: { filters?: ContextAuditFilters; groupBy?: TemporalGrouping; limit?: number }
): CacheAnalysisSummary | CacheAnalysisFull {
  const limit = options.limit ?? 20
  const filter = this.buildSessionFilters(options.filters)
  const where = this.whereClause(filter)
  const tokenGuard = where ? `${where} AND total_tokens > 0` : 'WHERE total_tokens > 0'

  if (detail === 'full') {
    return this.cacheAnalysisFull(tokenGuard, filter.params, limit)
  }
  return this.cacheAnalysisSummary(tokenGuard, filter.params, options.groupBy)
}

private cacheAnalysisSummary(
  where: string, params: readonly (string | number)[], groupBy?: TemporalGrouping
): CacheAnalysisSummary {
  const agg = this.db.prepare(`
    SELECT
      CAST(SUM(total_cache_read_tokens) AS REAL) * 100.0 /
        CASE WHEN SUM(total_tokens) = 0 THEN 1 ELSE SUM(total_tokens) END as overall_hit_ratio,
      AVG(CAST(COALESCE(total_cache_read_tokens, 0) AS REAL) /
        CASE WHEN total_tokens = 0 THEN 1 ELSE total_tokens END * 100) as avg_hit_ratio,
      SUM(total_cache_creation_tokens) as total_creation,
      SUM(total_cache_read_tokens) as total_read,
      COUNT(*) as session_count
    FROM sessions s ${where}
  `).get(...params) as {
    overall_hit_ratio: number | null; avg_hit_ratio: number | null
    total_creation: number | null; total_read: number | null; session_count: number
  }

  let periods: CacheAnalysisSummary['periods']
  if (groupBy) {
    const fmt = TEMPORAL_FORMATS[groupBy]
    periods = this.db.prepare(`
      SELECT strftime('${fmt}', s.started_at) as period,
             CAST(SUM(total_cache_read_tokens) AS REAL) * 100.0 /
               CASE WHEN SUM(total_tokens) = 0 THEN 1 ELSE SUM(total_tokens) END as overallHitRatio,
             AVG(CAST(COALESCE(total_cache_read_tokens, 0) AS REAL) /
               CASE WHEN total_tokens = 0 THEN 1 ELSE total_tokens END * 100) as avgHitRatio,
             SUM(total_cache_creation_tokens) as totalCacheCreation,
             SUM(total_cache_read_tokens) as totalCacheRead
      FROM sessions s ${where}
      GROUP BY period ORDER BY period
    `).all(...params) as any[]
  }

  return {
    overallHitRatio: agg.overall_hit_ratio ?? 0,
    avgHitRatio: agg.avg_hit_ratio ?? 0,
    totalCacheCreation: agg.total_creation ?? 0,
    totalCacheRead: agg.total_read ?? 0,
    sessionCount: agg.session_count,
    ...(periods ? { periods } : {}),
  }
}

private cacheAnalysisFull(
  where: string, params: readonly (string | number)[], limit: number
): CacheAnalysisFull {
  const rows = this.db.prepare(`
    SELECT id, topic, total_tokens,
           COALESCE(total_cache_creation_tokens, 0) as cache_creation,
           COALESCE(total_cache_read_tokens, 0) as cache_read,
           CAST(COALESCE(total_cache_read_tokens, 0) AS REAL) /
             CASE WHEN total_tokens = 0 THEN 1 ELSE total_tokens END * 100 as hit_ratio
    FROM sessions s ${where}
    ORDER BY hit_ratio ASC LIMIT ?
  `).all(...params, limit) as Array<{
    id: string; topic: string | null; total_tokens: number
    cache_creation: number; cache_read: number; hit_ratio: number
  }>

  return {
    sessions: rows.map(r => ({
      id: r.id,
      topic: r.topic,
      cacheHitRatio: Math.round(r.hit_ratio * 10) / 10,
      cacheCreationTokens: r.cache_creation,
      cacheReadTokens: r.cache_read,
      totalTokens: r.total_tokens,
    })),
  }
}
```

**collapse_analysis:**

```typescript
// ── collapse_analysis ──

collapseAnalysis(
  detail: ContextAuditDetail,
  options: { filters?: ContextAuditFilters; groupBy?: TemporalGrouping; limit?: number }
): CollapseAnalysisSummary | CollapseAnalysisFull {
  const limit = options.limit ?? 20
  const filter = this.buildSessionFilters(options.filters)
  const where = this.whereClause(filter)

  if (detail === 'full') {
    return this.collapseAnalysisFull(where, filter.params, limit)
  }
  return this.collapseAnalysisSummary(where, filter.params, options.groupBy)
}

private collapseAnalysisSummary(
  where: string, params: readonly (string | number)[], groupBy?: TemporalGrouping
): CollapseAnalysisSummary {
  const totalSessions = this.db.prepare(`
    SELECT COUNT(*) as cnt FROM sessions s ${where}
  `).get(...params) as { cnt: number }

  const agg = this.db.prepare(`
    SELECT COUNT(cc.id) as total_collapses,
           COUNT(DISTINCT cc.session_id) as sessions_with_collapses
    FROM context_collapses cc
    JOIN sessions s ON cc.session_id = s.id
    ${where}
  `).get(...params) as { total_collapses: number; sessions_with_collapses: number }

  // Session with most collapses
  const maxRow = this.db.prepare(`
    SELECT s.id, s.topic, COUNT(cc.id) as collapse_count
    FROM context_collapses cc
    JOIN sessions s ON cc.session_id = s.id
    ${where}
    GROUP BY s.id ORDER BY collapse_count DESC LIMIT 1
  `).get(...params) as { id: string; topic: string | null; collapse_count: number } | undefined

  let periods: CollapseAnalysisSummary['periods']
  if (groupBy) {
    const fmt = TEMPORAL_FORMATS[groupBy]
    periods = this.db.prepare(`
      SELECT strftime('${fmt}', s.started_at) as period,
             COUNT(cc.id) as totalCollapses,
             COUNT(DISTINCT s.id) as sessionCount,
             CAST(COUNT(cc.id) AS REAL) / MAX(COUNT(DISTINCT s.id), 1) as avgPerSession
      FROM sessions s
      LEFT JOIN context_collapses cc ON cc.session_id = s.id
      ${where}
      GROUP BY period ORDER BY period
    `).all(...params) as any[]
  }

  return {
    totalCollapses: agg.total_collapses,
    avgCollapsesPerSession: totalSessions.cnt > 0
      ? Math.round(agg.total_collapses / totalSessions.cnt * 100) / 100
      : 0,
    sessionsWithCollapses: {
      count: agg.sessions_with_collapses,
      percentage: totalSessions.cnt > 0
        ? Math.round(agg.sessions_with_collapses / totalSessions.cnt * 1000) / 10
        : 0,
    },
    maxCollapseSession: maxRow
      ? { id: maxRow.id, topic: maxRow.topic, costUsd: null, collapseCount: maxRow.collapse_count }
      : null,
    ...(periods ? { periods } : {}),
  }
}

private collapseAnalysisFull(
  where: string, params: readonly (string | number)[], limit: number
): CollapseAnalysisFull {
  // Get sessions that have collapses, ordered by collapse count
  const sessions = this.db.prepare(`
    SELECT s.id, s.topic, s.total_tokens, COUNT(cc.id) as cc_count
    FROM sessions s
    JOIN context_collapses cc ON cc.session_id = s.id
    ${where}
    GROUP BY s.id
    ORDER BY cc_count DESC LIMIT ?
  `).all(...params, limit) as Array<{
    id: string; topic: string | null; total_tokens: number; cc_count: number
  }>

  // Batch fetch collapses for all result sessions
  const sessionIds = sessions.map(s => s.id)
  if (sessionIds.length === 0) return { sessions: [] }

  const placeholders = sessionIds.map(() => '?').join(',')
  const collapseRows = this.db.prepare(`
    SELECT session_id, collapse_id, summary
    FROM context_collapses WHERE session_id IN (${placeholders})
  `).all(...sessionIds) as Array<{
    session_id: string; collapse_id: string; summary: string | null
  }>

  const bySession = new Map<string, Array<{ collapseId: string; summary: string | null }>>()
  for (const row of collapseRows) {
    if (!bySession.has(row.session_id)) bySession.set(row.session_id, [])
    bySession.get(row.session_id)!.push({ collapseId: row.collapse_id, summary: row.summary })
  }

  return {
    sessions: sessions.map(s => ({
      id: s.id,
      topic: s.topic,
      totalTokens: s.total_tokens,
      collapses: bySession.get(s.id) ?? [],
    })),
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/services/context-auditor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/context-auditor.ts src/services/context-auditor.test.ts
git commit -m "feat: add context_utilization, cache_analysis, collapse_analysis metrics"
```

---

## Task 5: ContextAuditor — session_profile Metric

**Files:**
- Modify: `src/services/context-auditor.ts`
- Modify: `src/services/context-auditor.test.ts`

- [ ] **Step 1: Add tests**

```typescript
describe('session_profile', () => {
  it('returns aggregate dashboard in summary mode', () => {
    const result = auditor.sessionProfile('summary', {}) as any
    expect(result.totalCost).toBeCloseTo(8.50)
    expect(result.totalTokens).toBe(350000)
    expect(result.sessionCount).toBe(3)
    expect(result.topExpensive.length).toBeLessThanOrEqual(3)
    expect(result.topTokenHeavy.length).toBeLessThanOrEqual(3)
    expect(result.topWorstCache.length).toBeLessThanOrEqual(3)
  })

  it('returns full profile per session', () => {
    const result = auditor.sessionProfile('full', {}) as any
    expect(result.sessions.length).toBe(3)
    const s1 = result.sessions.find((s: any) => s.id === 's1')
    expect(s1.cacheTokens.hitRatio).toBeGreaterThan(0)
    expect(s1.collapseCount).toBe(1)
    expect(s1.topTools.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/services/context-auditor.test.ts -t "session_profile"`
Expected: FAIL

- [ ] **Step 3: Implement session_profile**

Summary: compose from internal methods — reuse `costBreakdownSummary` for totalCost, query top-3 sessions by cost/tokens/cache. Full: batch query pattern — get sessions, then batch-fetch topTools for all session IDs in one `json_each` query.

```typescript
sessionProfile(
  detail: ContextAuditDetail,
  options: { filters?: ContextAuditFilters; limit?: number }
): SessionProfileSummary | SessionProfileFull {
  const limit = options.limit ?? 20
  const filter = this.buildSessionFilters(options.filters)
  const where = this.whereClause(filter)

  if (detail === 'full') {
    return this.sessionProfileFull(where, filter.params, limit)
  }
  return this.sessionProfileSummary(where, filter.params)
}
```

For `sessionProfileFull`, use batch query for topTools:
```sql
SELECT m.session_id, tool_name.value as tool_name, SUM(m.token_count) as total_tokens
FROM messages m, json_each(m.tool_names) as tool_name
WHERE m.session_id IN (?,?,?)
  AND m.tool_names IS NOT NULL AND m.role = 'user'
GROUP BY m.session_id, tool_name.value
ORDER BY m.session_id, total_tokens DESC
```
Then group in application layer, keeping top 5 per session.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/services/context-auditor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/context-auditor.ts src/services/context-auditor.test.ts
git commit -m "feat: add session_profile metric to ContextAuditor"
```

---

## Task 6: DI Registration + context_audit Tool

**Files:**
- Modify: `src/container/tokens.ts`
- Modify: `src/container/modules.ts`
- Create: `src/tools/context-audit.ts`
- Modify: `src/tools/index.ts`

- [ ] **Step 1: Add DI token**

In `src/container/tokens.ts`, add to the TOKENS object:
```typescript
ContextAuditor: Symbol('ContextAuditor'),
```

- [ ] **Step 2: Register service in DI container**

In `src/container/modules.ts`:
- Add import: `import { ContextAuditor } from '../services/context-auditor'`
- After `const analyzer = new Analyzer(db)` block, add:
```typescript
const contextAuditor = new ContextAuditor(db)
container.register(TOKENS.ContextAuditor, { useValue: contextAuditor })
```

- [ ] **Step 3: Create the tool file**

Create `src/tools/context-audit.ts`:

```typescript
import { container } from 'tsyringe'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { TOKENS } from '../container/tokens'
import type { FreshnessGuard } from '../services/freshness-guard'
import type { ContextAuditor } from '../services/context-auditor'
import type { ProjectResolver } from '../services/project-resolver'
import type { ResponseFormatter } from '../services/response-formatter'
import type { ContextAuditMetric, ContextAuditDetail, TemporalGrouping } from '../types/context-audit'

export function registerContextAudit(server: McpServer): void {
  server.tool(
    'context_audit',
    'First-class context usage auditing — cost breakdown, token attribution, cache analysis, context utilization, collapse tracking, and session profiling. Use detail=summary for aggregates, detail=full for per-session breakdowns.',
    {
      metric: z.enum([
        'cost_breakdown', 'token_attribution', 'context_utilization',
        'cache_analysis', 'collapse_analysis', 'session_profile',
      ]).describe('What to audit'),
      detail: z.enum(['summary', 'full']).optional().describe('summary = aggregates, full = per-session (default: summary)'),
      groupBy: z.enum(['day', 'week', 'month']).optional().describe('Temporal bucketing for trend analysis'),
      project: z.string().optional().describe('Filter by project slug'),
      path: z.string().optional().describe('Resolve project from filesystem path'),
      from: z.string().optional().describe('Start date ISO 8601'),
      to: z.string().optional().describe('End date ISO 8601'),
      minTokens: z.number().optional().describe('Minimum total_tokens'),
      maxTokens: z.number().optional().describe('Maximum total_tokens'),
      minCost: z.number().optional().describe('Minimum cost_usd'),
      maxCost: z.number().optional().describe('Maximum cost_usd'),
      minCacheHitRatio: z.number().min(0).max(100).optional().describe('Minimum cache hit ratio (0-100)'),
      maxCacheHitRatio: z.number().min(0).max(100).optional().describe('Maximum cache hit ratio (0-100)'),
      modelFilter: z.string().optional().describe('Filter to sessions using this model'),
      limit: z.number().int().min(1).max(100).optional().describe('Maximum results (default: 20)'),
    },
    async (params) => {
      const freshnessGuard = container.resolve<FreshnessGuard>(TOKENS.FreshnessGuard)
      const auditor = container.resolve<ContextAuditor>(TOKENS.ContextAuditor)
      const projectResolver = container.resolve<ProjectResolver>(TOKENS.ProjectResolver)
      const formatter = container.resolve<ResponseFormatter>(TOKENS.ResponseFormatter)

      const freshness = await freshnessGuard.ensureFresh()

      const projectSlug = await projectResolver.resolveProjectFilter({
        project: params.project,
        path: params.path,
      })

      const dateRange = (params.from || params.to)
        ? { from: params.from, to: params.to }
        : undefined

      const filters = {
        projectSlug: projectSlug ?? undefined,
        dateRange,
        minTokens: params.minTokens,
        maxTokens: params.maxTokens,
        minCost: params.minCost,
        maxCost: params.maxCost,
        minCacheHitRatio: params.minCacheHitRatio,
        maxCacheHitRatio: params.maxCacheHitRatio,
        modelFilter: params.modelFilter,
      }

      const detail: ContextAuditDetail = params.detail ?? 'summary'
      const metric: ContextAuditMetric = params.metric
      const groupBy: TemporalGrouping | undefined = params.groupBy
      const limit = params.limit

      let result: unknown
      switch (metric) {
        case 'cost_breakdown':
          result = auditor.costBreakdown(detail, { filters, groupBy, limit })
          break
        case 'token_attribution':
          result = auditor.tokenAttribution(detail, { filters, limit })
          break
        case 'context_utilization':
          result = auditor.contextUtilization(detail, { filters, groupBy, limit })
          break
        case 'cache_analysis':
          result = auditor.cacheAnalysis(detail, { filters, groupBy, limit })
          break
        case 'collapse_analysis':
          result = auditor.collapseAnalysis(detail, { filters, groupBy, limit })
          break
        case 'session_profile':
          result = auditor.sessionProfile(detail, { filters, limit })
          break
      }

      const meta = formatter.formatMeta(freshness)
      const response = formatter.format(result, meta)

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      }
    }
  )
}
```

- [ ] **Step 4: Register tool in tools/index.ts**

In `src/tools/index.ts`, add import `import { registerContextAudit } from './context-audit'` and call `registerContextAudit(server)` inside the `registerTools()` function, alongside the other tool registrations.

- [ ] **Step 5: Verify the server starts**

Run: `npx tsx src/server.ts` (should start without errors, Ctrl-C to stop)

- [ ] **Step 6: Commit**

```bash
git add src/container/tokens.ts src/container/modules.ts src/tools/context-audit.ts src/tools/index.ts
git commit -m "feat: register context_audit MCP tool"
```

---

## Task 7: Enhance list_sessions — Filters, Sorts, Output

**Files:**
- Modify: `src/tools/list-sessions.ts`

- [ ] **Step 1: Add new sort options to SORT_COLUMNS**

```typescript
const SORT_COLUMNS: Record<string, string> = {
  recent: 'started_at DESC',
  longest: 'duration_minutes DESC',
  most_turns: 'total_turns DESC',
  most_tokens: 'total_tokens DESC',
  errors: 'error_count DESC',
  cost: 'cost_usd IS NULL, cost_usd DESC',
  cache_efficiency: 'CAST(COALESCE(total_cache_read_tokens, 0) AS REAL) / CASE WHEN total_tokens = 0 THEN 1 ELSE total_tokens END ASC',
}
// Note: spec uses MAX(total_tokens, 1) for division-by-zero protection.
// Plan uses CASE WHEN consistently across all queries for clarity.
// Functionally equivalent — MAX(x, 1) is the scalar form in SQLite.
```

- [ ] **Step 2: Add new filter params to Zod schema**

Add to the tool's schema object:
```typescript
minTokens: z.number().optional().describe('Minimum total tokens'),
maxTokens: z.number().optional().describe('Maximum total tokens'),
minCost: z.number().optional().describe('Minimum cost in USD'),
maxCost: z.number().optional().describe('Maximum cost in USD'),
minCacheHitRatio: z.number().min(0).max(100).optional().describe('Minimum cache hit ratio (0-100)'),
maxCacheHitRatio: z.number().min(0).max(100).optional().describe('Maximum cache hit ratio (0-100)'),
```

Update `sortBy` enum to include `'cost'` and `'cache_efficiency'`.

- [ ] **Step 3: Add filter condition building**

After existing condition building, add:
```typescript
if (params.minTokens != null) {
  conditions.push('total_tokens >= ?')
  sqlParams.push(params.minTokens)
}
if (params.maxTokens != null) {
  conditions.push('total_tokens <= ?')
  sqlParams.push(params.maxTokens)
}
if (params.minCost != null) {
  conditions.push('cost_usd >= ?')
  sqlParams.push(params.minCost)
}
if (params.maxCost != null) {
  conditions.push('cost_usd <= ?')
  sqlParams.push(params.maxCost)
}
if (params.minCacheHitRatio != null) {
  conditions.push('(CAST(COALESCE(total_cache_read_tokens, 0) AS REAL) / CASE WHEN total_tokens = 0 THEN 1 ELSE total_tokens END * 100) >= ?')
  sqlParams.push(params.minCacheHitRatio)
}
if (params.maxCacheHitRatio != null) {
  conditions.push('(CAST(COALESCE(total_cache_read_tokens, 0) AS REAL) / CASE WHEN total_tokens = 0 THEN 1 ELSE total_tokens END * 100) <= ?')
  sqlParams.push(params.maxCacheHitRatio)
}
```

- [ ] **Step 4: Add cache columns to SELECT and new output fields**

Add `total_cache_read_tokens, total_cache_creation_tokens` to the SQL SELECT.

Add to the output mapping (medium resolution):
```typescript
cacheTokens: {
  creation: (row.total_cache_creation_tokens as number | null) ?? 0,
  read: (row.total_cache_read_tokens as number | null) ?? 0,
  hitRatio: Math.round(
    ((row.total_cache_read_tokens as number ?? 0) /
      Math.max(row.total_tokens as number, 1)) * 1000
  ) / 10,
},
```

Add contextCollapseCount via correlated subquery in the SQL:
```sql
(SELECT COUNT(*) FROM context_collapses WHERE session_id = sessions.id) as collapse_count
```

And in output mapping:
```typescript
contextCollapseCount: row.collapse_count as number,
```

Note: `costUsd` is already mapped in the existing output — verify it's present. If not, add `costUsd: row.cost_usd as number | null` to the medium-resolution mapping.

- [ ] **Step 5: Verify server starts and run any existing list_sessions tests**

Run: `npx vitest run --grep "list.sessions" 2>/dev/null; npx tsx src/server.ts` (quick smoke test)

- [ ] **Step 6: Commit**

```bash
git add src/tools/list-sessions.ts
git commit -m "feat: add token-aware filters, sorts, and cache output to list_sessions"
```

---

## Task 8: Enhance get_session — Cache, Accumulation, Collapses, Curve

**Files:**
- Modify: `src/tools/get-session.ts`

- [ ] **Step 1: Add hitRatio to existing cacheTokens at metadata level**

In the `if (detail === 'metadata' || detail === 'full')` block, change:
```typescript
result.cacheTokens = {
  creation: session.total_cache_creation_tokens ?? 0,
  read: session.total_cache_read_tokens ?? 0,
}
```
to:
```typescript
const cacheRead = session.total_cache_read_tokens ?? 0
const cacheCreation = session.total_cache_creation_tokens ?? 0
result.cacheTokens = {
  creation: cacheCreation,
  read: cacheRead,
  hitRatio: Math.round(
    (cacheRead / Math.max(session.total_tokens, 1)) * 1000
  ) / 10,
}
```

- [ ] **Step 2: Add tokenAccumulation at metadata level**

After cacheTokens, add:
```typescript
const peakMsg = db.prepare(
  'SELECT MAX(token_count) as peak FROM messages WHERE session_id = ?'
).get(params.sessionId) as { peak: number | null }

result.tokenAccumulation = {
  totalTokens: session.total_tokens,
  peakMessageTokens: peakMsg.peak ?? 0,
  avgTokensPerTurn: session.total_turns > 0
    ? Math.round(session.total_tokens / session.total_turns)
    : 0,
}
```

- [ ] **Step 3: Add contextCollapses enumeration and tokenCurve at full level**

In the `if (detail === 'full')` block, add (before the LLM analysis section):
```typescript
// Enumerate collapses (not just count)
const collapses = db.prepare(
  'SELECT collapse_id, summary, first_archived_uuid, last_archived_uuid FROM context_collapses WHERE session_id = ?'
).all(params.sessionId) as Array<{
  collapse_id: string; summary: string | null
  first_archived_uuid: string | null; last_archived_uuid: string | null
}>
result.contextCollapses = collapses.map(c => ({
  collapseId: c.collapse_id,
  summary: c.summary,
  firstArchivedUuid: c.first_archived_uuid,
  lastArchivedUuid: c.last_archived_uuid,
}))

// Token accumulation curve
const msgs = db.prepare(
  'SELECT token_count FROM messages WHERE session_id = ? ORDER BY timestamp'
).all(params.sessionId) as Array<{ token_count: number }>

let cumulative = 0
const collapseCount = collapses.length
const totalMsgs = msgs.length
// Interpolate collapse positions evenly across the session
const collapsePositions = new Set(
  Array.from({ length: collapseCount }, (_, i) =>
    Math.round((totalMsgs / (collapseCount + 1)) * (i + 1))
  )
)

result.tokenCurve = msgs.map((m, i) => {
  cumulative += m.token_count
  return {
    turnIndex: i,
    cumulativeTokens: cumulative,
    isCollapse: collapsePositions.has(i),
  }
})
```

- [ ] **Step 4: Verify server starts**

Run: `npx tsx src/server.ts`

- [ ] **Step 5: Commit**

```bash
git add src/tools/get-session.ts
git commit -m "feat: add context metrics, token curve, and collapse enumeration to get_session"
```

---

## Task 9: Cost Index + Final Integration Test

**Files:**
- Modify: `src/services/context-auditor.ts` (add index creation method)

- [ ] **Step 1: Add cost_usd index creation**

Add a method to `ContextAuditor`:
```typescript
ensureIndexes(): void {
  this.db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_cost_usd ON sessions(cost_usd)')
}
```

Call it from `modules.ts` after instantiation:
```typescript
const contextAuditor = new ContextAuditor(db)
contextAuditor.ensureIndexes()
container.register(TOKENS.ContextAuditor, { useValue: contextAuditor })
```

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 3: Start server and verify tool list**

Run: `npx tsx src/server.ts` — verify `context_audit` appears in tool list and server starts cleanly.

- [ ] **Step 4: Commit**

```bash
git add src/services/context-auditor.ts src/container/modules.ts
git commit -m "feat: add cost_usd index and finalize context audit integration"
```

---

## Task 10: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add context_audit to the Available Tools table**

Add row:
```
| `context_audit` | Context usage auditing — cost, token attribution, cache, collapses, session profiles |
```

Update the tool count from 12 to 13.

- [ ] **Step 2: Add a Context Usage Auditing section**

After the "Efficiency Fixes" section, add:
```markdown
## Context Usage Auditing (2026-04-06)

New `context_audit` tool with 6 metrics for first-class context usage analysis:

- **cost_breakdown**: Total/avg cost, min/max sessions, temporal trends
- **token_attribution**: Which tools consume the most context (tool result tokens)
- **context_utilization**: Token accumulation stats, collapse frequency
- **cache_analysis**: Cache hit ratios, creation vs read trends
- **collapse_analysis**: Context collapse frequency and details
- **session_profile**: Complete context profile per session

All metrics support `detail=summary|full`, temporal `groupBy`, and filters (project, date range, token range, cost range, cache hit ratio, model).

`list_sessions` enhanced with: `minTokens`, `maxTokens`, `minCost`, `maxCost`, `minCacheHitRatio`, `maxCacheHitRatio` filters; `cost` and `cache_efficiency` sort options; `cacheTokens` and `contextCollapseCount` in medium output.

`get_session` enhanced with: `cacheTokens.hitRatio` and `tokenAccumulation` at metadata level; `contextCollapses` array and `tokenCurve` at full level.

Phase 1 limitation: `token_count` = input+output combined; true context utilization % deferred to Phase 2 when `input_tokens`/`output_tokens` are stored separately.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document context_audit tool and list/get_session enhancements"
```
