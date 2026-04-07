# Context Usage Auditing & Analytics

**Date:** 2026-04-06
**Phase:** 1 of 2 (Query-layer only — no schema migrations)

## Problem

The session-history MCP captures per-message token counts, cache tokens, cost, and context collapses, but provides no first-class way to explore sessions through a context-usage lens. Callers cannot answer questions like "where is my money going?", "which tools eat the most context?", or "why did this session burn so many tokens?" without manually querying multiple tools and computing metrics themselves.

## Approach

Phased delivery. Phase 1 (this spec) adds context-usage querying capabilities using only existing schema — no migrations, no re-indexing. Phase 2 (future spec) adds `input_tokens`/`output_tokens` column split on messages, a `tool_calls` table for per-call attribution, and pre-computed session-level utilization metrics.

Phase 1 delivers three changes:
1. New `context_audit` tool for dedicated context-usage analytics
2. Enhanced `list_sessions` with token-aware filtering and sorting
3. Enhanced `get_session` with richer context metrics and accumulation curves

## 1. `context_audit` Tool

New MCP tool purpose-built for context-usage exploration.

### Parameters

```typescript
interface ContextAuditParams {
  metric: 'cost_breakdown' | 'token_attribution' | 'context_utilization'
        | 'cache_analysis' | 'collapse_analysis' | 'session_profile'
  detail: 'summary' | 'full'          // default: 'summary'
  groupBy?: 'day' | 'week' | 'month'  // temporal bucketing
  filters?: {
    projectSlug?: string
    dateRange?: { from?: string; to?: string }
    minTokens?: number
    maxTokens?: number
    minCost?: number
    maxCost?: number
    minCacheHitRatio?: number          // 0-100
    maxCacheHitRatio?: number          // 0-100
    modelFilter?: string               // matches against models_used JSON array via json_each
  }
  limit?: number                       // default: 20
}
```

**Filter semantics:**
- `projectSlug`, `dateRange`: applied to `sessions.project_slug`, `sessions.started_at`
- `minTokens`/`maxTokens`: applied to `sessions.total_tokens`
- `minCost`/`maxCost`: applied to `sessions.cost_usd`
- `minCacheHitRatio`/`maxCacheHitRatio`: values must be 0-100 (not 0-1); tool validates range and returns error if outside bounds
- `modelFilter`: matches via `EXISTS (SELECT 1 FROM json_each(s.models_used) WHERE value = ?)` — matches any model used in the session
```

### Metrics

#### `cost_breakdown`

Where is the money going?

**Summary:**
- `totalCost`: `SUM(cost_usd)` across matching sessions
- `avgCost`: `AVG(cost_usd)`
- `sessionCount`: number of matching sessions
- `minCostSession`: `{ id, topic, costUsd }` — cheapest
- `maxCostSession`: `{ id, topic, costUsd }` — most expensive
- When `groupBy` is set: array of `{ period, totalCost, avgCost, sessionCount }`

**Full:**
- Per-session rows: `{ id, topic, startedAt, costUsd, totalTokens, cacheTokens: { creation, read } }`
- Sorted by `cost_usd DESC NULLS LAST`
- `cost_usd: null` means missing data, never estimated

**SQL (summary):**
```sql
SELECT
  SUM(cost_usd) as total_cost,
  AVG(cost_usd) as avg_cost,
  COUNT(*) as session_count
FROM sessions
WHERE <filters>
```

**SQL (groupBy):**
```sql
SELECT
  strftime('<format>', started_at) as period,
  SUM(cost_usd) as total_cost,
  AVG(cost_usd) as avg_cost,
  COUNT(*) as session_count
FROM sessions
WHERE <filters>
GROUP BY period
ORDER BY period
```

Where `<format>` is `%Y-%m-%d` (day), `%Y-W%W` (week, approximate — `%W` uses Monday-start, not ISO 8601 week numbering), `%Y-%m` (month).

#### `token_attribution`

Which tools consume the most context?

Primary signal: **tool result messages** (role=user with `tool_names`) — these represent tool response content filling the context window. Tool call generation (role=assistant) is cheap by comparison.

**Summary:**
- Top-N tools ranked by `SUM(token_count)` of their result messages
- Each entry: `{ toolName, totalTokens, messageCount, pctOfTotal }`
- `pctOfTotal` = tool's tokens / sum of all tool result tokens * 100

**Full:**
- Per-session breakdown: `{ sessionId, topic, tools: [{ toolName, resultTokens, callTokens }] }`
- `resultTokens`: sum of token_count from user messages containing this tool name
- `callTokens`: sum of token_count from assistant messages containing this tool name

**Multi-tool overcounting:** When a message contains multiple tool names, the full message `token_count` is credited to each tool. This is a known Phase 1 limitation — it overstates individual tool costs but preserves correct totals when tools are viewed independently. Phase 2's `tool_calls` table resolves this.

**SQL (summary, per-tool):**
```sql
SELECT
  tool_name.value as tool_name,
  SUM(m.token_count) as total_tokens,
  COUNT(*) as message_count
FROM messages m
JOIN sessions s ON m.session_id = s.id,
json_each(m.tool_names) as tool_name
WHERE m.tool_names IS NOT NULL
  AND m.role = 'user'
  AND <session_filters on s.project_slug, s.started_at, etc.>
GROUP BY tool_name.value
ORDER BY total_tokens DESC
LIMIT ?
```

All filter parameters (`projectSlug`, `dateRange`, `modelFilter`) apply to session columns (`s.project_slug`, `s.started_at`, `s.models_used`), not message columns.

Total for percentage: separate query `SUM(token_count) FROM messages m JOIN sessions s ON m.session_id = s.id WHERE m.tool_names IS NOT NULL AND m.role = 'user' AND <session_filters>`.

#### `context_utilization`

How do tokens accumulate across a session?

Phase 1 limitation: `input_tokens` and `output_tokens` are not stored separately — only `token_count` (sum). True context window utilization % requires knowing `input_tokens` alone (the context size the model saw). Phase 1 reports **token accumulation** — cumulative `token_count` growth — as a proxy for context trajectory. Phase 2 stores separate columns and enables true utilization %.

**Summary:**
- `avgTotalTokens`: average `total_tokens` across matching sessions
- `medianTotalTokens`: median — requires fetching all matching `total_tokens` values via `SELECT total_tokens FROM sessions WHERE <filters> ORDER BY total_tokens` and computing in application layer (SQLite lacks `PERCENTILE_CONT`). For large datasets (10K+ sessions), consider capping at a sample or dropping this field.
- `maxTotalTokens`: highest token session
- `avgPeakMessageTokens`: average of each session's largest single-message `token_count`
- `sessionsWithCollapses`: count and percentage of sessions that had at least one context collapse
- When `groupBy` is set: `{ period, avgTotalTokens, sessionCount, collapseRate }`

**Full:**
- Per-session: `{ id, topic, totalTokens, peakMessageTokens, collapseCount, totalTurns }`
- `totalTurns` sourced from `sessions.total_turns` (not message count — turns are logical conversation steps, messages are individual entries)
- Sorted by `total_tokens DESC`

**SQL (summary):**
```sql
SELECT
  AVG(s.total_tokens) as avg_total,
  MAX(s.total_tokens) as max_total,
  COUNT(*) as session_count,
  SUM(CASE WHEN cc.cnt > 0 THEN 1 ELSE 0 END) as sessions_with_collapses
FROM sessions s
LEFT JOIN (
  SELECT session_id, COUNT(*) as cnt
  FROM context_collapses
  GROUP BY session_id
) cc ON cc.session_id = s.id
WHERE <filters>
```

#### `cache_analysis`

How effectively is prompt caching being used?

**Summary:**
- `overallHitRatio`: `SUM(total_cache_read_tokens) / SUM(total_tokens) * 100`
- `totalCacheCreation`: aggregate creation tokens
- `totalCacheRead`: aggregate read tokens
- `avgHitRatio`: average of per-session hit ratios
- `sessionCount`: matching sessions
- When `groupBy` is set: `{ period, overallHitRatio, avgHitRatio, totalCacheCreation, totalCacheRead }`

**Full:**
- Per-session: `{ id, topic, cacheHitRatio, cacheCreationTokens, cacheReadTokens, totalTokens }`
- Sorted by `cacheHitRatio ASC` (worst first — consistent with analyze tool convention)

**SQL (summary):**
```sql
SELECT
  CAST(SUM(total_cache_read_tokens) AS REAL) * 100.0 /
    CASE WHEN SUM(total_tokens) = 0 THEN 1 ELSE SUM(total_tokens) END as overall_hit_ratio,
  AVG(CAST(COALESCE(total_cache_read_tokens, 0) AS REAL) /
    CASE WHEN total_tokens = 0 THEN 1 ELSE total_tokens END * 100) as avg_hit_ratio,
  SUM(total_cache_creation_tokens) as total_creation,
  SUM(total_cache_read_tokens) as total_read,
  COUNT(*) as session_count
FROM sessions
WHERE total_tokens > 0 AND <filters>
```

#### `collapse_analysis`

When and how often does context get compressed?

**Summary:**
- `totalCollapses`: total collapse events across matching sessions
- `avgCollapsesPerSession`: mean
- `sessionsWithCollapses`: count and percentage
- `maxCollapseSession`: `{ id, topic, collapseCount }` — session with most collapses
- When `groupBy` is set: `{ period, totalCollapses, sessionCount, avgPerSession }`

**Full:**
- Per-session: `{ id, topic, totalTokens, collapses: [{ collapseId, summary }] }`
- Sorted by collapse count DESC

**SQL (summary):**
```sql
SELECT
  COUNT(cc.id) as total_collapses,
  COUNT(DISTINCT cc.session_id) as sessions_with_collapses,
  (SELECT COUNT(*) FROM sessions s2 WHERE <filters on s2>) as total_sessions
FROM context_collapses cc
JOIN sessions s ON cc.session_id = s.id
WHERE <filters on s>
```

#### `session_profile`

Complete context profile for filtered sessions — all metrics in one view.

**Summary:**
- Aggregate stats: total cost, total tokens, avg cache hit ratio, total collapses, session count
- Top-3 most expensive sessions
- Top-3 most token-heavy sessions
- Top-3 worst cache efficiency sessions

**Full:**
- Per-session complete profile:
```typescript
{
  id: string
  topic: string
  startedAt: string
  durationMinutes: number
  costUsd: number | null
  totalTokens: number
  cacheTokens: { creation: number; read: number; hitRatio: number }
  collapseCount: number
  turnCount: number
  peakMessageTokens: number
  topTools: Array<{ toolName: string; tokenCount: number }>  // top 5
  modelsUsed: string[]
}
```

**Implementation:** `session_profile` summary composes internally from other metric methods (`costBreakdown.summary()`, `cacheAnalysis.summary()`, etc.) to avoid duplicating SQL. Full mode uses a batch query for `topTools` — fetch tool attribution for all result session IDs in one query (keyed by `session_id`), then attach to each session object. Avoids N correlated subqueries with `json_each`.

## 2. `list_sessions` Enhancements

### New Filter Parameters

```typescript
{
  // existing: project, path, branch, from, to
  minTokens?: number
  maxTokens?: number
  minCost?: number
  maxCost?: number
  minCacheHitRatio?: number   // 0-100
  maxCacheHitRatio?: number   // 0-100
}
```

Token and cost filters: `WHERE total_tokens >= ? AND total_tokens <= ?`, `WHERE cost_usd >= ? AND cost_usd <= ?`. Direct indexed column filters (note: `cost_usd` needs an index — add in implementation).

Cache hit ratio filters: computed expression in WHERE clause:
```sql
WHERE (CAST(COALESCE(total_cache_read_tokens, 0) AS REAL) / MAX(total_tokens, 1) * 100) >= ?
  AND (CAST(COALESCE(total_cache_read_tokens, 0) AS REAL) / MAX(total_tokens, 1) * 100) <= ?
```

### New Sort Options

Added to existing `SORT_COLUMNS` map:

| Key | SQL | Direction | Notes |
|-----|-----|-----------|-------|
| `cost` | `cost_usd IS NULL, cost_usd DESC` | Expensive first, NULLs last | Two-column sort for NULL handling |
| `cache_efficiency` | `CAST(COALESCE(total_cache_read_tokens, 0) AS REAL) / MAX(total_tokens, 1) ASC` | Worst first | Consistent with analyze tool convention |

### New Output Fields (medium resolution)

```typescript
{
  // all existing fields, plus:
  costUsd: number | null
  cacheTokens: {
    creation: number
    read: number
    hitRatio: number       // 0-100, computed server-side
  }
  contextCollapseCount: number
}
```

- `costUsd` and `cacheTokens.creation`/`read`: already in the sessions row, just not exposed — zero cost to add.
- `cacheTokens.hitRatio`: inline computation `(read / MAX(total_tokens, 1)) * 100`. Follows rich indexing principle.
- `contextCollapseCount`: correlated subquery `(SELECT COUNT(*) FROM context_collapses WHERE session_id = s.id)`. Cheap for paginated results.
- All skipped at `low` resolution.

## 3. `get_session` Enhancements

### `metadata` Detail Level — Additions

```typescript
{
  // existing cacheTokens: { creation, read }
  cacheTokens: {
    creation: number
    read: number
    hitRatio: number              // NEW
  }
  tokenAccumulation: {            // NEW
    totalTokens: number
    peakMessageTokens: number     // max(token_count) across messages
    avgTokensPerTurn: number      // total_tokens / total_turns
  }
}
```

`peakMessageTokens`: `SELECT MAX(token_count) FROM messages WHERE session_id = ?`. Single indexed query.

### `full` Detail Level — Additions

```typescript
{
  // everything from metadata, plus:
  contextCollapses: Array<{       // NEW: enumerate collapses, not just count
    collapseId: string
    summary: string | null
    firstArchivedUuid: string | null
    lastArchivedUuid: string | null
  }>
  tokenCurve: Array<{             // NEW: accumulation curve
    turnIndex: number
    cumulativeTokens: number
    isCollapse: boolean
  }>
}
```

`tokenCurve` construction:
1. Query messages ordered by timestamp: `SELECT id, token_count FROM messages WHERE session_id = ? ORDER BY timestamp`
2. Query collapses: `SELECT collapse_id FROM context_collapses WHERE session_id = ?`
3. Compute running sum of `token_count` across messages, incrementing `turnIndex` for each message.
4. Mark collapse points: Since collapse UUIDs (`first_archived_uuid`, `last_archived_uuid`) reference JSONL message UUIDs which may not match database message IDs, Phase 1 uses a simpler approach — interpolate collapse positions based on the collapse count and session length (evenly distributed). This is approximate. Phase 2 will store collapse position metadata (turn index or timestamp) directly for precise overlay.
5. Return array of `{ turnIndex, cumulativeTokens, isCollapse }`

This represents the session's token growth trajectory with collapse events overlaid. Not true context utilization % (requires separate `input_tokens` — Phase 2), but shows the growth shape and where the context was compressed.

## Implementation Notes

### Service Layer

New `ContextAuditor` service registered in DI container. Follows existing `Analyzer` pattern:
- One method per metric
- Accepts filters, detail level, groupBy, limit
- Returns typed result objects
- SQL queries use parameterized inputs

### Tool Registration

Single tool file `src/tools/context-audit.ts` following existing tool patterns. Delegates to `ContextAuditor` service.

### json_each Dependency

`token_attribution` uses SQLite's `json_each()` table-valued function to explode `tool_names` JSON arrays. Available in better-sqlite3's bundled SQLite (3.45+). No external dependency.

### Index Addition

Add index on `cost_usd` for sort/filter performance:
```sql
CREATE INDEX IF NOT EXISTS idx_sessions_cost_usd ON sessions(cost_usd)
```

Added via `CREATE INDEX IF NOT EXISTS` in service initialization. While the project uses versioned migrations (V1-V4), this is a pure optimization index with no schema semantics — running it idempotently on startup is simpler than a V5 migration for a single index. If Phase 2 introduces a V5 migration, this index should be folded into it.

## Phase 2 Scope (Future Spec)

Not part of this implementation, but designed to build on Phase 1:

- **v5 migration**: Split `token_count` → `input_tokens` + `output_tokens` on messages table. Requires full re-index.
- **`tool_calls` table**: Per-tool-call token estimates extracted during JSONL parsing. Eliminates multi-tool overcounting.
- **Pre-computed utilization**: `peak_input_tokens` and `context_utilization_pct` on sessions table, computed at index time.
- **True utilization curves**: `tokenCurve` uses `input_tokens` instead of `token_count`, mapped against model context window limits.
- **Performance indexes**: Composite indexes for common filter+sort combinations.

## Known Phase 1 Limitations

| Limitation | Impact | Phase 2 Resolution |
|------------|--------|---------------------|
| No input/output token split | Can't compute true context window utilization % | Separate columns on messages |
| Multi-tool overcounting | Token attribution inflated for multi-tool messages | `tool_calls` table |
| Accumulation curve uses token_count not input_tokens | Curve shape is correct but absolute values include output tokens | Use input_tokens for curve |
| cost_usd NULL for older sessions | Cost metrics incomplete for historical data | No fix — data not in JSONL |
| No per-model cost split | Can't attribute cost to specific models in multi-model sessions | Requires per-message cost tracking |
