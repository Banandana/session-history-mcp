# Claude Session MCP — Project Overview

An MCP server that gives AI agents structured, queryable access to Claude Code session history. Built so agents can learn from past sessions — what was tried, what worked, what failed, and how the user corrected course.

## Why This Exists

Claude Code sessions are ephemeral. Each conversation starts from scratch. The agent has no memory of what happened in previous sessions beyond what's saved in CLAUDE.md and memory files. This MCP server bridges that gap by indexing session JSONL files into a queryable SQLite database and exposing them through tools designed for agent consumption.

The core use case: an agent working on a KiCad schematic can ask "what happened last time we touched the decoupling caps?" and get a focused answer without reading 500 raw messages.

## Philosophy

### Rich Indexing — Compute at Write Time, Not Read Time

The central design principle. Every piece of data the MCP returns should be immediately useful without follow-up queries. This means:

- **Session metrics** (duration, error count, tool usage, files changed) are computed when the session is indexed, not when a tool is called
- **Heuristic topics** are generated from the first user message + dominant tool categories at index time
- **LLM narrative summaries** are generated asynchronously from distilled conversations at index time
- **Human-readable labels** replace raw UUIDs everywhere — `"2026-03-25 — Full schematic audit — schematic work"` instead of `"ae290dbc-018d-49dd-a6ed-996704e4e0bc"`

The caller should never see a wall of IDs and have to make 10 follow-up requests to understand what they're looking at.

### Self-Describing Data

Every response should paint a picture. A `list_sessions` call returns enough context per session (topic, duration, error count, summary) that the agent can decide which sessions matter without drilling into any of them. The data describes itself.

### The Caller Knows What They Need

Resolution and focus are intent-driven. The agent knows before it asks whether it's casually scanning ("show me recent sessions") or deeply investigating ("what tool calls happened in this specific session"). The MCP respects that intent:

- `resolution=low` — fast scanning, minimal fields
- `resolution=medium` — standard browsing with pre-computed summaries
- `focus=tools|errors|files|decisions` — structural lens on conversation data
- `intent="find sessions where footprints changed"` — live LLM analysis

### Lists Are for Scanning, Not Analysis

`list_sessions` gives you enough to pick candidates. Deep analysis happens on `get_session`. This separation keeps list queries fast (pure SQL, no LLM) while enabling rich per-session analysis when needed.

## Architecture

### Data Flow

```
Filesystem JSONL files (~/.claude/projects/*/session-id.jsonl)
    ↓
ClaudeCodeAdapter — discovers sessions, detects changes via byte offset
    ↓
FreshnessGuard — orchestrates incremental sync
    ↓
Index Pipeline (per session):
    1. Parse JSONL → NormalizedMessage[]
    2. Insert messages, file_changes, subagents into SQLite
    3. Aggregate metrics (counts, timestamps, tool usage)
    4. Generate heuristic topic from first user message + tool categories
    5. Async: distill conversation → LLM narrative summary
    ↓
SQLite Index (sessions, messages, messages_fts, file_changes, subagents)
    ↓
MCP Tool Queries — read from stored columns, no runtime aggregation
```

### Incremental Sync

The server doesn't re-index everything on every call. It tracks byte offsets per session file. On each `ensureFresh()` call:

1. Compare current file sizes against stored byte offsets
2. New sessions → full index pipeline
3. Changed sessions (file grew) → re-index messages, file_changes, subagents, recompute metrics
4. Deleted sessions → cascade delete from all tables

This makes sync fast (~100ms for no changes, ~6s for a full re-index of 58 sessions).

### Schema Design

Everything computed at index time lives as a column on `sessions`:

```sql
sessions (
  -- identity
  id, source, project_slug, cwd, branch,
  -- timestamps
  started_at, ended_at,
  -- metrics (computed at index time)
  duration_minutes, message_count, error_count, correction_count,
  subagent_count, total_tokens, total_turns,
  -- structured data (JSON columns)
  tool_counts,     -- {"Grep": 93, "Edit": 26, ...}
  files_changed,   -- [{"path": "src/foo.ts", "op": "edit"}, ...]
  -- narrative (heuristic + LLM)
  topic,           -- "Full schematic audit — schematic work, code exploration"
  summary,         -- LLM-generated 2-3 sentence narrative
  summary_generated_at,
  -- sync tracking
  byte_offset, version, indexed_at
)
```

This means `list_sessions` is a single `SELECT ... FROM sessions ORDER BY X` — no joins, no aggregation, no LLM calls at query time.

### Schema Migration

Uses `PRAGMA user_version` for versioning. Migration v0→v1 adds the metric columns via individual `ALTER TABLE ADD COLUMN` statements (SQLite limitation), drops the legacy `summaries` table, and creates sort indexes. Idempotent — checks column existence before adding.

## LLM Usage

### Two-Tier Summary System

**Tier 1: Heuristic Topic (always available, no LLM)**

Generated deterministically from indexed data:
1. First real user message (skipping slash commands, system injections)
2. Dominant tool categories classified by regex patterns
3. Error count indicator for high-error sessions

Example: `"do a full audit of the schematics — schematic work, code exploration"`

**Tier 2: LLM Narrative Summary (async, best-effort)**

Generated from a distilled conversation fed to a local LLM:
1. Conversation is distilled to a minimal chat format (first 10 + last 10 messages, tool calls collapsed, thinking/results dropped)
2. Structured metrics are appended
3. Local LLM generates a 2-3 sentence narrative
4. Stored on the session row — never recomputed unless explicitly requested

The LLM summary runs **async and non-blocking** (`void this.generateSummaries()`). The sync pipeline never waits for LLM responses. Summaries populate in the background, max 5 per sync cycle, with 15-second timeout per session.

### Live LLM Analysis (Intent)

When an agent calls `get_session` with `intent="find where footprints were changed"`:
1. Conversation is distilled with the specified focus
2. LLM receives metrics + distilled conversation + intent
3. LLM returns whether the session is relevant and why
4. Result is **never cached** — each intent query is fresh

This is the "squinting" mechanism. The agent doesn't read raw conversations. The MCP's LLM does the reading on the agent's behalf.

## Conversation Distillation

The ConversationDistiller transforms raw JSONL messages into minimal chat suitable for LLM consumption or agent browsing. It's the core of both summary generation and the focus system.

### Bookend Selection

For long conversations (500+ messages), reading everything is impractical. The distiller selects the first N and last N messages — the "bookends" that capture intent (beginning) and outcome (end). Default N=10.

Exception: `focus=errors` bypasses bookends entirely and scans the full message array for error/correction messages with ±1 context window.

### Focus Modes

The distiller is parameterized by focus, which controls what gets preserved vs collapsed:

| Focus | Preserves | Collapses |
|-------|-----------|-----------|
| `general` | User/assistant text, tool names | Tool params, results, thinking |
| `tools` | Tool names + key input params (`Edit: auth.ts`, `ref=U5, footprint=SOIC-20`) | Thinking, successful results |
| `errors` | Error messages, corrections, ±1 context window | Everything between errors → `[... 14 messages ...]` |
| `files` | File paths from Read/Write/Edit/Glob/Grep | Non-file tools, verbose text |
| `decisions` | User messages + assistant reasoning text | All tool activity |

### Tool Parameter Extraction

For `focus=tools`, the distiller extracts meaningful params from `tool_use` input:
- File tools → basename: `Read: auth.ts`
- Bash → command preview: `Bash: npm test -- --coverage`
- KiCad MCP → domain params: `mcp__kicad__edit_schematic_component: ref=U5, footprint=SOIC-20`
- Unknown → just the tool name

### Topic Sanitization

User messages can contain Claude Code system protocol artifacts (XML command tags, system caveats). The topic generator:
1. Strips all XML/HTML tags
2. Collapses whitespace
3. Skips slash commands (`/clear`, `/mcp`)
4. Skips system injections (`Caveat: ...`, `Note: ...`)
5. Falls through to the next candidate user message
6. Truncates on word boundaries

## Agent MCP Contract

### Tool Design for Agents

Every tool is designed for a specific agent workflow:

| Tool | Agent Workflow | Key Design Decision |
|------|----------------|-------------------|
| `list_sessions` | "What happened recently?" | Returns enough per session to skip follow-ups. `resolution` controls density. `sortBy` enables different browsing strategies. |
| `get_session` | "Tell me about this session" | Three detail levels: `summary` (compact card), `metadata` (tool counts, files), `full` (conversation sample). `focus` + `intent` for targeted analysis. |
| `get_conversation` | "Show me the actual messages" | Token budgeting prevents context overflow. `window` selects start/end/errors/corrections. `focus` adds a distilled view alongside raw messages. |
| `search` | "Find sessions mentioning X" | FTS5 full-text search across all messages. Content previews for quick relevance assessment. |
| `analyze` | "What patterns exist?" | Aggregated metrics: error-prone sessions, tool failures, frequently changed files. Human-readable labels. |
| `list_projects` | "What projects exist?" | Session counts, memory/CLAUDE.md status per project. |
| `get_memory` | "What does the agent remember?" | Cross-project memory access with type filtering. |

### Token Efficiency

The MCP is designed to minimize the tokens an agent consumes:

1. **Pre-computed summaries** — Agent reads a 2-sentence summary instead of 500 raw messages
2. **Resolution levels** — `low` returns ~50 tokens per session, `medium` ~200, `full` ~2000
3. **Focus modes** — Agent asks for exactly the lens it needs, gets only relevant content
4. **Pagination** — Cursor-based pagination prevents loading entire result sets
5. **Token budgeting** — `get_conversation` accepts a `maxTokens` parameter and fits messages within budget using priority-based selection

### Error Handling Patterns

- Tool-level errors return structured `{error: "message"}` — never throw
- LLM failures are graceful: `analysis: null`, `summary: null` — the rest of the response is still useful
- Sync failures don't block tool responses — stale data is better than no data

## Patterns Worth Stealing

### 1. Index-Time Computation

Don't make the query path do work. If you know what the caller will need, compute it when the data arrives. This is the single biggest improvement we made — switching from query-time aggregation to stored columns cut response complexity by 80%.

### 2. Conversation Distillation

Raw LLM conversations are noisy. Tool calls, thinking blocks, system messages, tool results — most of it is machinery, not meaning. The distiller pattern (extract the human dialogue, collapse tool activity into action summaries) is universally useful for any system that needs to summarize or analyze agent conversations.

### 3. Heuristic + LLM Two-Tier Summaries

Don't block on LLM. Have a fast heuristic that's always available (topic from first message + tool categories), and a richer LLM narrative that fills in asynchronously. The user/agent always sees something useful immediately.

### 4. Focus as Parameterized Distillation

Instead of one-size-fits-all summaries, let the caller specify what lens to use. The same conversation looks different through `focus=tools` vs `focus=decisions` vs `focus=errors`. This is a general pattern for any system that summarizes complex data — the summarizer should be configurable, not fixed.

### 5. Intent-Driven Analysis

Let the caller describe *why* they're looking, and have the MCP's LLM do the analytical work. The agent says "find where footprints changed" and gets back a relevance assessment instead of raw data to sift through. This moves analytical work from the (expensive, context-limited) calling agent to the (cheap, focused) MCP-side LLM.

### 6. Byte-Offset Incremental Sync

Don't re-index everything on every call. Track how much of each file you've processed. Only parse new content. This keeps sync under 200ms for typical usage (no changes) while supporting full re-index when needed.

### 7. Human-Readable Labels Everywhere

Never return a raw UUID where a date + topic can be derived. The `analyze` tool was nearly useless when it returned `"a9aba105-31f7-4be3-85bb-6d8dc2db1ea5"` as a label. Now it returns `"2026-03-25 — Full schematic audit — schematic work"`. Same data, 100x more useful.

### 8. Non-Intent Message Filtering

Agent conversations start with protocol noise — slash commands, system caveats, XML tags. Any system that extracts meaning from the first user message needs to skip these and find the first real human intent. Our topic generator fetches 5 candidate messages and uses the first one that passes a set of filters.

### 9. Lists for Scanning, Details for Analysis

Resist the urge to make list endpoints do deep analysis. Lists should be fast SQL queries that return enough context to pick candidates. Deep work (LLM analysis, full conversation distillation) happens on single-item endpoints. This keeps the common path fast and the rare path powerful.

### 10. Async Fire-and-Forget for Expensive Operations

LLM summarization runs `void this.generateSummaries()` — no await. The sync pipeline returns immediately. Summaries populate in the background. The caller sees them on the next request. This pattern works for any expensive enrichment that isn't needed immediately.

## Tech Stack

| Component | Choice | Why |
|-----------|--------|-----|
| Language | TypeScript (strict, ESM) | Type safety, ecosystem |
| MCP SDK | `@modelcontextprotocol/sdk` | Official protocol implementation |
| Database | better-sqlite3 | Synchronous API, WAL mode, FTS5 for search |
| DI | tsyringe | Decorator-based, clean service registration |
| Testing | vitest | Fast, ESM-native, colocated tests |
| LLM | Local (vLLM/compatible) | No external API dependency, low latency |
| Runtime | Node.js + tsx | Direct TS execution, no build step |
