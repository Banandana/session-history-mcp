# Conversation Navigation Redesign

## Problem

`get_conversation` tries to do three jobs: overview, search, and detail view. The result is a tool with a bloated parameter surface (`focus`, `window`, `roles`, `includeToolResults`) where no mode works well. Users report:

- No way to filter to specific content (e.g., just tool calls)
- Can't control the sample window or request specific turns
- Can't get full detail on tool call inputs/outputs
- The `focus` parameter produces vague summaries with no path to drill deeper

The fundamental issue: the overview is a dead end. There's no navigation flow from "what happened" to "show me exactly."

## Design

Replace the monolithic `get_conversation` with a three-tool navigation flow:

1. **`get_conversation`** (slimmed) — "What happened in this session?" → phase-clustered overview
2. **`query_turns`** (new) — "Find turns matching criteria" → lightweight references
3. **`get_turns`** (new) — "Show me these specific turns" → full content

### Navigation Flow

```
get_conversation(sessionId)
  → phases with turn ranges, stats, tools used
  → caller identifies area of interest

query_turns(sessionId, toolNames=["Bash"], isError=true)
  → matching turns: [{turnIndex: 47, turnId: "abc", summary: "Bash: npm test → exit 1"}, ...]
  → caller picks specific turns

get_turns(sessionId, turnRange={from: 45, to: 50})
  → full content: text, tool inputs, tool outputs, everything
```

## Tool Contracts

### `get_conversation` (overview)

Stripped to one job: give the caller a navigable overview of a session.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `sessionId` | string | yes | Session ID |
| `maxTokens` | number | no | Token budget for response |

**Removed parameters:** `focus`, `window`, `roles`, `includeToolResults`, `cursor`, `limit`. These concerns move to `query_turns` and `get_turns`.

**Response shape:**

```typescript
interface ConversationOverview {
  sessionId: string
  metadata: {
    topic?: string
    summary?: string
    startedAt: string
    endedAt?: string
    durationMinutes?: number
    model?: string
    totalTurns: number
    totalTokens?: number
    errorCount: number
    correctionCount: number
    toolBreakdown: Record<string, number>  // tool name → call count
    filesChanged: string[]
  }
  phases: Phase[]
}

interface Phase {
  turnRange: { from: number; to: number }  // inclusive indices
  description: string                        // e.g., "explored codebase (Read, Grep)"
  toolNames: string[]                        // distinct tools used
  errorCount: number
  turnCount: number
}
```

**Phase clustering algorithm:**

Each turn is assigned a category. Consecutive turns of the same category are grouped into a phase.

**Category assignment (in priority order):**
1. **Error** — `isError=true` (takes priority regardless of tools used)
2. **Modify** — turn contains Edit, Write, or NotebookEdit
3. **Execute** — turn contains Bash or Agent(*)
4. **Explore** — turn contains Read, Glob, Grep, LS, or Agent(Explore)
5. **Discuss** — text-only turns (no tool calls)

Mixed-tool turns use the highest-priority category present.

**Phase boundary rules:**
- A new phase starts when the category changes from the previous turn
- Adjacent phases of the same category are always merged
- Single-turn phases surrounded by the same category on both sides get absorbed (prevents fragmentation from one-off tool calls)

**Token budget (`maxTokens`) behavior:**
When the overview exceeds budget, apply in order:
1. Truncate `filesChanged` to top 10
2. Truncate `toolBreakdown` to top 10
3. Merge smallest adjacent phases until under budget (combine turn ranges, union tool names, sum error counts)

Target: 5–20 phases per session. If a session has fewer than 10 turns, skip phase clustering and return one phase per turn.

### `query_turns` (search/filter)

Find turns matching structured criteria. Works within a single session (JSONL parsing) or across sessions (DB query via `turn_events` table).

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `sessionId` | string | no | Scope to one session |
| `projectId` | string | no | Scope to a project's sessions |
| `toolNames` | string[] | no | Filter turns containing any of these tools |
| `isError` | boolean | no | Only error turns |
| `isCorrection` | boolean | no | Only correction turns |
| `roles` | string[] | no | Filter by role (`user`, `assistant`) |
| `textPattern` | string | no | Substring or regex match against turn text content |
| `timeRange` | object | no | `{ after?: string, before?: string }` ISO timestamps |
| `turnRange` | object | no | `{ from?: number, to?: number }` index range within session |
| `limit` | number | no | Max results (default 50) |
| `cursor` | string | no | Pagination cursor |

**Constraints:**
- At least one of `sessionId` or `projectId` required (no unbounded cross-project scans)
- `turnRange` only valid when `sessionId` is provided
- `textPattern` only valid when `sessionId` is provided (full-text search requires JSONL parsing; cross-session queries can only match against `text_preview` in the DB, which is too limited to be reliable)
- Cross-session queries (`projectId` without `sessionId`) use the `turn_events` DB table

**Response shape:**

```typescript
interface QueryTurnsResult {
  turns: TurnReference[]
  totalMatches: number
  pagination: { cursor?: string; hasMore: boolean }
}

interface TurnReference {
  sessionId: string
  turnIndex: number
  turnId: string
  timestamp: string
  role: string
  summary: string           // one-line: text preview or "[Bash: git status]" or "[error: ...]"
  toolNames: string[]
  isError: boolean
  isCorrection: boolean
  matchContext?: string      // if textPattern was used, the matching snippet
}
```

**Summary generation:**
- Text-only turn: first ~120 chars of text content
- Tool turn: `[ToolName: key_param]` using the existing `extractToolParams` logic
- Multi-tool turn: `[Tool1, Tool2, Tool3]` with params on the primary tool
- Error turn: `[error: first 120 chars of error text]`

### `get_turns` (detail expansion)

Return full content for specific turns. This is where you see everything — tool inputs, tool outputs, text, the works.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `sessionId` | string | yes | Session ID |
| `turnIds` | string[] | no | Specific turn UUIDs |
| `turnRange` | object | no | `{ from: number, to: number }` inclusive index range |
| `includeToolResults` | boolean | no | Include full tool output (default: `true`) |
| `maxTokens` | number | no | Budget cap — truncates tool results first, then tool inputs |

**Constraints:**
- One of `turnIds` or `turnRange` required (mutually exclusive)
- `turnIds` capped at 50 entries per request
- `turnRange` capped at 50 turns per request

**Response shape:**

```typescript
interface GetTurnsResult {
  sessionId: string
  turns: ExpandedTurn[]
  truncated: boolean        // true if maxTokens caused truncation
}

interface ExpandedTurn {
  turnIndex: number
  turnId: string
  role: string
  timestamp: string
  contentBlocks: ContentBlock[]  // full blocks: text, tool_use (with input), tool_result (with output)
  toolNames: string[]
  isError: boolean
  isCorrection: boolean
  tokenUsage?: TokenUsage
}
```

**Content handling:**
- Thinking blocks are stripped (not useful for post-hoc review)
- `includeToolResults` defaults to `true` — the point of this tool is full detail
- When `maxTokens` is set and content exceeds budget, truncation order:
  1. Truncate tool_result content (longest first)
  2. Truncate tool_use input (longest first)
  3. Truncate text blocks (longest first)
  4. Drop turns from the middle of the range (keep first and last)

## DB Schema: `turn_events` Table

Cross-session queries need structured per-turn data indexed in the database. Currently sync only stores session-level aggregates.

```sql
CREATE TABLE turn_events (
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_index    INTEGER NOT NULL,
  turn_id       TEXT NOT NULL,
  role          TEXT NOT NULL,
  timestamp     TEXT NOT NULL,
  tool_names    TEXT NOT NULL DEFAULT '[]',  -- JSON array
  is_error      INTEGER NOT NULL DEFAULT 0,
  is_correction INTEGER NOT NULL DEFAULT 0,
  text_preview  TEXT,          -- first ~200 chars of text content
  PRIMARY KEY (session_id, turn_index)
);

CREATE INDEX idx_turn_events_error ON turn_events(is_error) WHERE is_error = 1;
CREATE INDEX idx_turn_events_correction ON turn_events(is_correction) WHERE is_correction = 1;
CREATE INDEX idx_turn_events_timestamp ON turn_events(timestamp);
```

**Tool name querying:** Since `tool_names` is a JSON array, queries use `json_each`:

```sql
SELECT * FROM turn_events, json_each(turn_events.tool_names) AS tn
WHERE tn.value IN ('Bash', 'Edit')
```

**Relationship to existing tables:** The `sessions` table stores session-level aggregates (errorCount, toolCounts, etc.). `turn_events` stores per-turn structured data. They serve different query scopes — `sessions` for listing/filtering sessions, `turn_events` for filtering within/across sessions at turn granularity. No existing tables are replaced.

**Sync integration:** The `turn_events` table is populated during `FreshnessGuard.syncChangedSessions()`. For each changed session, parse the JSONL and upsert turn events. This replaces no existing behavior — it's additive.

**Migration/backfill:** Add table creation to `database.ts` schema initialization. Existing sessions are backfilled lazily — `turn_events` rows are populated for a session on first access via `query_turns` if not already indexed. A `turn_events_indexed` boolean column on `sessions` tracks which sessions have been indexed. This avoids a blocking bulk backfill on upgrade.

## What Gets Removed

- `get_conversation` parameters: `focus`, `window`, `roles`, `includeToolResults`, `cursor`, `limit`
- `conversation-distiller.ts` — the entire distiller service. Phase clustering replaces it.
- `token-budget-manager.ts` `filterByWindow()` and priority-scoring logic — no longer needed. Token budgeting in `get_turns` uses simpler truncation (longest-first).
- The `Focus` type from `types/session.ts`

## What Gets Added

- `src/tools/query-turns.ts` — new tool registration
- `src/tools/get-turns.ts` — new tool registration
- `src/services/phase-clusterer.ts` — phase detection for overview
- `src/services/turn-indexer.ts` — populates `turn_events` during sync
- `turn_events` table + indices in DB schema

## What Gets Modified

- `src/tools/get-conversation.ts` — stripped to overview-only, uses phase clusterer
- `src/infrastructure/database.ts` — add `turn_events` table
- `src/services/freshness-guard.ts` — call turn indexer during sync
- `src/tools/index.ts` — register new tools
- `src/container/modules.ts` — register PhaseClusterer and TurnIndexer in DI container
- `src/container/tokens.ts` — add DI tokens for new services
- Tool count in CLAUDE.md: 9 → 11
