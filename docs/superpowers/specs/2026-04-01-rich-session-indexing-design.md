# Rich Session Indexing

**Date**: 2026-04-01
**Status**: Approved
**Goal**: Make every MCP response self-describing with rich metrics and narratives computed at index time, so agent callers never need follow-up queries to understand what a session contains.

## Problem

Current `list_sessions` returns bare `{id, startedAt}` — a wall of UUIDs. Callers must fetch each session individually to learn anything about it. `computedSummary` exists but is computed at query time from raw SQL aggregation, has no narrative, and isn't available on list views. Sessions lack `endedAt`. Analyze labels are raw session IDs. The MCP contract forces multiple round-trips for basic comprehension.

## Design Principles

1. **Index-time computation** — All metrics, topics, and summaries are computed during sync and stored as columns. Query time is read-only.
2. **Self-describing data** — Every response contains enough context for the caller to understand what it represents without follow-up queries. No raw IDs where labels can be derived.
3. **Structured + narrative** — Metrics give the machine-readable shape; LLM narrative gives the human-readable story. Both always present.

## Schema Changes

### `sessions` table — new columns

| Column | Type | Source |
|--------|------|--------|
| `ended_at` | TEXT | MAX(timestamp) from messages |
| `duration_minutes` | INTEGER | Computed from started_at / ended_at |
| `message_count` | INTEGER | COUNT of indexed messages |
| `error_count` | INTEGER | COUNT of is_error messages |
| `correction_count` | INTEGER | COUNT of is_correction messages |
| `subagent_count` | INTEGER | COUNT from subagents |
| `tool_counts` | TEXT (JSON) | `{"Grep": 93, "Read": 52, ...}` |
| `files_changed` | TEXT (JSON) | `[{"path": "CLAUDE.md", "op": "edit"}, ...]` |
| `topic` | TEXT | Heuristic-generated short label |
| `summary` | TEXT | LLM-generated narrative (2-3 sentences) |
| `summary_generated_at` | TEXT | ISO 8601 timestamp of LLM generation |

### Drop `summaries` table

Remove the `summaries` table, `SummaryService`, and its DI token. The `summary-service.ts` file is deleted. Any references in `get-session.ts` to the summaries table are removed.

### Migration

Schema versioning via `PRAGMA user_version`. Current schema is version 0 (implicit). This migration is version 1.

In `IndexManager.ensureSchema()`, after `CREATE TABLE IF NOT EXISTS`:

1. Check `PRAGMA user_version` — if < 1, run migration
2. Add each column individually via separate `ALTER TABLE sessions ADD COLUMN` statements (SQLite requires one per statement)
3. Drop `summaries` table: `DROP TABLE IF EXISTS summaries`
4. Set `PRAGMA user_version = 1`
5. Mark all existing sessions as needing recomputation by setting `topic IS NULL` (the backfill trigger)

On next `ensureFresh()`, sessions with `topic IS NULL` are treated as "changed" and go through the full metrics + topic + summary pipeline. This avoids a separate backfill mechanism.

## Index-Time Computation Pipeline

All computation is orchestrated by `FreshnessGuard` but delegated to dedicated services. `FreshnessGuard`'s constructor grows to accept `ConversationDistiller`, `TopicGenerator`, and `LocalLlmClient` — update `modules.ts` manual construction accordingly. Both `syncNewSessions()` and `syncChangedSessions()` must run the full pipeline (messages, file_changes, subagents, then metrics/topic/summary). Currently `syncChangedSessions()` only re-indexes messages — it must be extended to also re-index file_changes and subagents before computing metrics.

### `list_sessions` data source change

**Critical**: `list_sessions` currently iterates the adapter's filesystem discovery (`registry.discoverSessions()`), not the database. This must be rewritten to query the `sessions` table directly. The adapter is only used during sync — all reads come from the index.

### Step 1: Aggregate Metrics

After all messages for a session are inserted, compute from the indexed data:

```
ended_at        = MAX(messages.timestamp) WHERE session_id = ?
duration_minutes = (ended_at - started_at) / 60000
message_count   = COUNT(*) FROM messages WHERE session_id = ?
error_count     = COUNT(*) FROM messages WHERE session_id = ? AND is_error = 1
correction_count = COUNT(*) FROM messages WHERE session_id = ? AND is_correction = 1
subagent_count  = COUNT(*) FROM subagents WHERE session_id = ?
tool_counts     = TypeScript aggregation: split messages.tool_names on ',', count occurrences, serialize as JSON. Stored pre-computed in sessions.tool_counts column.
files_changed   = DISTINCT (file_path, operation) FROM file_changes WHERE session_id = ?, serialized as JSON array
```

### Step 2: Generate Heuristic Topic

Built deterministically from indexed data. No LLM needed.

**Algorithm:**
1. Take first user message `content_preview` (truncated to ~60 chars)
2. Classify dominant tool category from `tool_counts`:
   - KiCad MCP tools -> "schematic work"
   - Grep/Read heavy -> "code exploration"
   - Edit/Write heavy -> "code changes"
   - Bash heavy -> "shell operations"
   - WebFetch/WebSearch -> "research"
   - Mixed -> top 2 categories
3. Append error indicator if `error_count > 5`

**Examples:**
- `"Full schematic audit — schematic work, code changes"`
- `"Add unit tests for auth — code changes, 8 errors"`
- `"Explore codebase structure — code exploration"`

### Step 3: Generate LLM Summary

Runs after metrics and topic are computed. Depends on local LLM availability.

**Input construction — ConversationDistiller service:**

1. Extract first N messages + last N messages from the JSONL (N=10 default, tunable)
2. Transform into minimal chat dialogue:
   - **User messages**: kept verbatim (truncated to ~500 chars if very long)
   - **Assistant text blocks**: kept verbatim (truncated to ~500 chars)
   - **Tool use sequences**: collapsed to single-line action summaries (e.g., `[read src/auth.ts]`, `[edited 3 files]`, `[ran tests — 129/130 passed]`)
   - **Tool results**: dropped entirely
   - **Thinking blocks**: dropped entirely
3. Append structured metrics block

**LLM prompt:**

```
Session metrics:
- Duration: 206 min, 560 turns, 106K tokens
- Errors: 4, Corrections: 1
- Tools: Grep(93), Read(52), Edit(26), KiCad MCP(~150)
- Files changed: CLAUDE.md (edit), .mcp.json (create)

Conversation (condensed):
user: do a full audit of the schematics
assistant: I'll run a full schematic audit using KiCad diagnostics.
[ran 6 KiCad diagnostic tools]
assistant: Found 116 dangling wires, duplicate refs, ERC errors. Fixing now.
[edited schematic components, added no-connect flags, fixed wiring]
assistant: Audit complete. ERC errors 1→0, duplicates 7→0, dangling wires 4→0.
...
user: search api key is 65b5888c-...
assistant: Done. Add API keys to .mcp.json and restart.

Summarize this session in 2-3 sentences. Focus on what was accomplished and the outcome.
```

**Output**: Stored in `summary` column. If LLM unavailable, `summary` stays NULL and `topic` (heuristic) is the only label.

**LLM error handling:**
- "Unavailable" = connection refused, timeout (10s max per session), or HTTP 5xx
- Failed summaries leave `summary` as NULL — they will be retried on the next sync cycle (sessions with `topic IS NOT NULL AND summary IS NULL` are candidates for summary-only backfill)
- **Summarization is async and non-blocking**: sync completes with metrics + topic immediately. LLM summaries are generated after sync returns, so the first `ensureFresh()` call is never blocked by LLM latency. Subsequent calls pick up the generated summaries.
- Batch limit: max 5 sessions per sync cycle to avoid overwhelming the LLM

**Backfill**: On first sync after migration, sessions with `topic IS NULL` are re-indexed. Those with `summary IS NULL` after re-indexing are queued for async LLM summarization (max 5 per cycle).

**Edge cases:**
- Sessions with 0 messages: `ended_at` = `started_at`, `duration_minutes` = 0, topic = `"Empty session"`, no LLM summary attempted
- Active sessions (file still growing): metrics are computed from current messages. On next sync, if byte offset changed, metrics are recomputed. No special flag needed — `ended_at` simply updates.

## Tool Contract Changes

### `list_sessions` — enriched response

**New parameters:**
- `sortBy`: `"recent"` (default) | `"longest"` | `"most_turns"` | `"most_tokens"` | `"errors"` — maps to ORDER BY on `started_at DESC`, `duration_minutes DESC`, `total_turns DESC`, `total_tokens DESC`, `error_count DESC`

**Response shape per session:**

```json
{
  "id": "ae290dbc-...",
  "projectSlug": "-home-kitty-Desktop-ginny-board",
  "startedAt": "2026-03-24T17:31:29Z",
  "endedAt": "2026-03-24T20:56:38Z",
  "durationMinutes": 206,
  "totalTurns": 560,
  "totalTokens": 106202,
  "errorCount": 4,
  "topic": "Full schematic audit — schematic work, code changes",
  "summary": "User requested full schematic audit. Claude ran ERC diagnostics, fixed duplicate reference designators and dangling wires, added no-connect flags, and set up Mouser MCP for BOM sourcing. All ERC errors resolved."
}
```

**Implementation**: Single SQL query on `sessions` table. No joins, no aggregation at query time.

```sql
SELECT id, source, project_slug, cwd, branch, started_at, ended_at,
       duration_minutes, total_turns, total_tokens, message_count,
       error_count, topic, summary
FROM sessions
WHERE project_slug = ? [AND started_at >= ? AND started_at <= ?]
ORDER BY <sortBy column> DESC
LIMIT ? OFFSET ?
```

### `get_session` — simplified detail levels

- **`detail=summary`** (default): Same compact card as list view
- **`detail=metadata`**: Adds `toolCounts` (JSON), `filesChanged` (JSON), `correctionCount`, `subagentCount`, `subagents[]`
- **`detail=full`**: Adds `subagents[]` with full metadata, conversation samples (first/last N messages in distilled format)

All read from stored columns — no query-time computation of `computedSummary`.

### `analyze` — human-readable labels

Replace raw session IDs in labels with `topic` (or `startedAt + topic` for uniqueness).

**Before:**
```json
{"label": "a9aba105-31f7-4be3-85bb-6d8dc2db1ea5", "count": 47}
```

**After:**
```json
{"label": "2026-03-25 — COP wiring and component placement", "count": 47, "sessionId": "a9aba105-..."}
```

## New Service: ConversationDistiller

**Location**: `src/services/conversation-distiller.ts`

**Purpose**: Transform raw JSONL messages into a minimal chat dialogue suitable for LLM summarization.

**Interface:**
```typescript
interface DistilledConversation {
  readonly messages: readonly DistilledMessage[];
  readonly estimatedTokens: number;
}

interface DistilledMessage {
  readonly role: 'user' | 'assistant' | 'action';
  readonly text: string;
}
```

**Rules:**
- `user` role: original text, truncated to 500 chars
- `assistant` role: text blocks only, truncated to 500 chars
- `action` role: collapsed tool sequences — `[read src/foo.ts]`, `[edited 3 files]`, `[ran bash: npm test]`
- Consecutive tool_use blocks from the same assistant turn merge into one `action` line
- Thinking blocks: dropped
- Tool results: dropped
- System messages: dropped

**Token budget**: Target ~2000 tokens total for LLM input (metrics + distilled conversation). If conversation exceeds budget, reduce N (message count from each end) until it fits.

## CLAUDE.md Update

Add to Architecture Rules:

> **Rich indexing** — All data returned by MCP tools must be self-describing and immediately useful to the caller. Compute metrics, summaries, and labels at index time. Never return raw IDs where human-readable labels can be derived. The caller should never need a follow-up query to understand what a result represents.

## New Indexes

```sql
CREATE INDEX IF NOT EXISTS idx_sessions_duration ON sessions(duration_minutes);
CREATE INDEX IF NOT EXISTS idx_sessions_total_turns ON sessions(total_turns);
CREATE INDEX IF NOT EXISTS idx_sessions_error_count ON sessions(error_count);
CREATE INDEX IF NOT EXISTS idx_sessions_total_tokens ON sessions(total_tokens);
```

Added in migration step alongside new columns.

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `src/services/conversation-distiller.ts` | Create | Pure module (exported functions, not a DI service) — distill JSONL into minimal chat for LLM |
| `src/services/topic-generator.ts` | Create | Pure module — heuristic topic from metrics |
| `src/services/index-manager.ts` | Modify | Add new columns, migration via PRAGMA user_version, new indexes |
| `src/services/freshness-guard.ts` | Modify | Orchestrate full pipeline (messages + file_changes + subagents + metrics + topic + async summary). Extend syncChangedSessions to re-index file_changes and subagents. Add ConversationDistiller, TopicGenerator, LocalLlmClient to constructor. |
| `src/services/summary-service.ts` | Delete | Replaced by direct LLM calls in freshness-guard + sessions.summary column |
| `src/tools/list-sessions.ts` | Rewrite | Switch from adapter iteration to SQL query on sessions table. Add sortBy param. |
| `src/tools/get-session.ts` | Modify | Read from stored columns, remove query-time computedSummary aggregation, remove summaries table reference |
| `src/tools/analyze.ts` | Modify | Join on sessions.topic for human-readable labels |
| `src/services/analyzer.ts` | Modify | Include sessions.topic and started_at in result labels |
| `src/types/session.ts` | Modify | Add new fields to SessionMeta (endedAt, durationMinutes, errorCount, topic, summary, etc.) |
| `src/container/modules.ts` | Modify | Register new services, update FreshnessGuard constructor |
| `src/container/tokens.ts` | Modify | Add DI tokens for new services, remove SummaryService token |
| `CLAUDE.md` | Modify | Add rich indexing rule (done) |

## Testing

- **ConversationDistiller**: Unit test with sample JSONL messages — verify tool collapsing, truncation, token budget
- **TopicGenerator**: Unit test with various tool_counts profiles — verify category classification
- **FreshnessGuard**: Integration test — index a session, verify all metrics columns populated
- **list_sessions**: E2E test — verify sortBy options, verify response shape includes topic/summary
- **Migration**: Test that existing DB gets columns added and backfill triggers
