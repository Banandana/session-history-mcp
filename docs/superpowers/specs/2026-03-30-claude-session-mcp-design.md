# Session History MCP Server — Design Spec

**Date:** 2026-03-30
**Claude Code Version Baseline:** 2.1.87
**Status:** Approved

## Vision

An MCP server that provides LLM agents with first-class access to session history data. The primary use case is enabling the agent self-improvement feedback loop: agents autonomously explore their own history to identify failure patterns, user corrections, inefficient tool usage, and recurring problems — then act on those findings.

The user should never have to read session history themselves. The tools support autonomous agent-driven exploration with cheap pagination, aggregation queries, and anomaly-highlighting summaries.

**Broader trajectory:** This will evolve into a centralized store for all LLM agent session history (Claude Code, OpenHands, future tools). The data model is agent-agnostic from the start. Claude Code is the first adapter.

## Architecture

Single-process monolithic server with three DI-managed layers:

```
┌─────────────────────────────────────────────┐
│  MCP Tool Layer (9 tools)                   │
│  Thin param validation + routing            │
├─────────────────────────────────────────────┤
│  LLM Optimization Layer                     │
│  Token budgeting, truncation, pagination,   │
│  structured summaries, summary caching      │
│         ↕ HTTP (OpenAI-compat)              │
│  Local LLM Client (10.1.10.20:30000)        │
├─────────────────────────────────────────────┤
│  Data Client Layer                          │
│  Adapter-based, normalized types            │
│         ↕                                   │
│  SQLite (FTS5 index + metadata cache)       │
│         ↕                                   │
│  ~/.claude/ filesystem (source of truth)    │
└─────────────────────────────────────────────┘
```

- Data flows downward for reads: tool → optimization → data client → filesystem/SQLite
- Caching flows sideways: optimization layer writes LLM-generated summaries back to SQLite via data client
- DI container (tsyringe) wires all layers; each depends only on interfaces from the layer below

## Data Client Layer

### Source Adapters

Agent-agnostic adapter interface. v1 ships Claude Code adapter only.

```
┌─────────────────────────────────────────┐
│  Unified Query Interface                │
│  (what the optimization layer calls)    │
├─────────────────────────────────────────┤
│  Adapter Registry                       │
│  Routes queries to the right adapter(s) │
├──────────┬──────────┬───────────────────┤
│ Claude   │ OpenHands│ Future            │
│ Code     │ (future) │ Adapters          │
│ Adapter  │          │                   │
└──────────┴──────────┴───────────────────┘
```

**Adapter contract:**

```typescript
interface SessionAdapter {
  readonly source: string  // "claude-code", "openhands", etc.

  discoverProjects(): AsyncIterable<ProjectMeta>
  discoverSessions(project?: string): AsyncIterable<SessionMeta>
  getMessages(sessionId: string): AsyncIterable<NormalizedMessage>
  getFileChanges(sessionId: string): AsyncIterable<FileChange>
  getSubagents(sessionId: string): AsyncIterable<SubagentMeta>
  getMemory(project?: string): AsyncIterable<MemoryEntry>
  resolveProject(path: string): ProjectMeta | undefined
  checkFreshness(known: IndexState): FreshnessResult
}
```

- `AsyncIterable` everywhere — stream through large JSONL without loading into memory
- Each adapter normalizes its source format into shared types
- Adapter registry merges results from all registered adapters
- Adding a new adapter = implement interface, register in DI container, no other changes

### Claude Code Adapter Components

| Component | Reads From | Produces |
|-----------|-----------|----------|
| `SessionDiscovery` | `projects/*/sessions-index.json` + `sessions/*.json` | Session metadata |
| `ConversationParser` | `{project}/{sessionId}.jsonl` | Normalized message stream — groups content blocks by `requestId` + `message.id` into complete turns |
| `SubagentParser` | `{sessionId}/subagents/agent-*.jsonl` + `.meta.json` | Subagent conversations with type/description |
| `ToolResultResolver` | `{sessionId}/tool-results/*` + `<persisted-output>` refs | Full tool outputs from inline or file-backed storage |
| `FileChangeExtractor` | `file-history-snapshot` entries + `file-history/{sessionId}/` | File operations with before-snapshots |
| `MemoryReader` | `{project}/memory/MEMORY.md` + individual files | Parsed memory with frontmatter |
| `ConfigReader` | CLAUDE.md, settings.json, stats-cache.json | Project/global configuration |

**Critical parsing detail:** Assistant messages in JSONL are one line per content block, not per API response. `ConversationParser` must reconstruct full turns by grouping on `requestId`. `stop_reason: null` = more blocks coming.

### Indexing Strategy

SQLite is the index, not the warehouse. JSONL files are the source of truth.

**What goes in SQLite (extracted metadata):**

| Table | Key Fields |
|-------|-----------|
| `sessions` | id, source, project_slug, cwd, branch, started_at, model, total_tokens, total_turns, summary_text, byte_offset |
| `messages` | id, session_id, role, type, timestamp, model, token_count, has_tool_use, tool_names, is_error, is_correction |
| `messages_fts` | FTS5 virtual table — content preview (~200 chars), enough for search ranking |
| `file_changes` | session_id, message_id, file_path, operation, timestamp |
| `subagents` | id, session_id, type, description, total_tokens, total_tools, duration_ms |
| `memory_entries` | project_slug, name, type, description, content |
| `summaries` | entity_type, entity_id, summary_text, generated_at |

**What stays on disk (accessed on demand):**
- Full message content — read from JSONL when tool requests conversation content
- Tool result bodies — resolved from `tool-results/` files only when requested
- File history snapshots — raw file backups only when diffing

**Indexing triggers:**
- Lazy — first query that hits a table triggers build for that data type
- Incremental — byte_offset tracking per JSONL file, only parse new lines
- Memory files — re-read on access (tiny, no caching needed)

**Size estimate:** ~100 sessions × 500 messages = 20-30MB index. Manageable.

### Freshness Guarantees

The index must be authoritative. No query ever returns stale data.

Every query goes through a freshness gate:

```
Tool call → FreshnessGuard checks what's changed since last sync
  - stat() project directories for mtime changes
  - compare known JSONL file sizes vs current (byte offset)
  - check for new session directories/files
    ↓
If stale → incremental sync (only new/changed data)
    ↓
Execute query against up-to-date index
```

**Every tool response includes freshness metadata:**

```typescript
interface ResponseMeta {
  readonly indexedAt: string
  readonly sessionCount: number
  readonly staleSessions: number    // should always be 0 post-check
  readonly syncDurationMs: number
}
```

If something is genuinely missing (corrupted file, unknown format), the response says so explicitly — never silent gaps.

`fs.watch` is an optional optimization for background pre-sync, but the freshness gate is the guarantee.

## LLM Optimization Layer

### Services

| Service | Responsibility |
|---------|---------------|
| `TokenBudgetManager` | Takes maxTokens param, decides content inclusion. Smart truncation: preserve first/last messages, tool boundaries, user corrections, errors. |
| `PaginationManager` | Cursor-based windowing. Returns page + cursor + total estimate. |
| `SummaryService` | Generates/caches session summaries via local LLM. Returns cached if available. |
| `LocalLlmClient` | OpenAI-compatible HTTP client for `10.1.10.20:30000/v1` (MiniMax-M2.5-AWQ, 128k context). Summarization and future embedding tasks. |
| `ResponseFormatter` | Consistent `ToolResponse<T>` shaping for all tools. |
| `Analyzer` | SQL aggregation queries for pattern discovery — error rates, corrections, tool failures, costs. |

**LLM usage principle:** Use LLMs only for what regular code can't do (summarization, embeddings). Metadata extraction, filtering, pagination, aggregation — all regular code.

**Token budgeting flow:**

```
Tool call: { sessionId: "abc", maxTokens: 2000 }
    ↓
TokenBudgetManager estimates content size
    ↓
If fits → return directly
If too large → check for cached summary → return
If no cache → delegate to SummaryService → cache → return
```

**Smart truncation rules (code, not LLM):**
- Preserve conversation boundaries (never cut mid-turn)
- Keep user corrections (messages after assistant messages that change direction)
- Keep tool errors and retries (friction signal)
- Drop thinking blocks (empty in storage anyway)
- Drop large tool results, keep tool name + params + success/failure

## MCP Tool Surface

9 composable tools with consistent response shapes.

| # | Tool | Purpose | Key Params |
|---|------|---------|------------|
| 1 | `list_projects` | All known projects with metadata | `sortBy?`, `limit?` |
| 2 | `get_project` | Project detail — CLAUDE.md, settings, memory, stats, sessions | `project?`, `path?`, `detail?` |
| 3 | `list_sessions` | Sessions filtered/sorted | `project?`, `path?`, `branch?`, `dateRange?`, `limit?`, `cursor?` |
| 4 | `get_session` | Session detail — metadata, turns, files, subagents, cost | `sessionId`, `detail?` |
| 5 | `get_conversation` | Conversation content with token budgeting | `sessionId`, `maxTokens?`, `roles?`, `includeToolResults?`, `cursor?`, `window?` |
| 6 | `search` | FTS5 across all sessions | `query`, `project?`, `path?`, `dateRange?`, `maxResults?`, `cursor?` |
| 7 | `get_changes` | File operations from sessions | `sessionId?`, `filePath?`, `operation?`, `cursor?` |
| 8 | `get_memory` | Cross-project memory access | `project?`, `path?`, `type?`, `search?` |
| 9 | `analyze` | Aggregation/pattern discovery | `metric`, `project?`, `path?`, `dateRange?`, `limit?` |

**Project resolution:** Any tool accepting `project?` also accepts `path?` — an absolute path resolved by walking up the directory tree to find the matching project slug.

**`analyze` metrics:** `"errors"`, `"corrections"`, `"tool_failures"`, `"costly_sessions"`, `"frequent_files"`

**`get_conversation` windows:** `"start"`, `"end"`, `"errors"`, `"corrections"` — server-side filtering so the agent gets the relevant parts without reading everything.

**Consistent response shape:**

```typescript
interface ToolResponse<T> {
  readonly data: T
  readonly pagination?: {
    readonly cursor: string
    readonly hasMore: boolean
    readonly totalEstimate: number
  }
  readonly meta: ResponseMeta
}
```

## Project Structure

```
src/
  types/
    session.ts              # Session, message, turn normalized types
    project.ts              # Project, config, memory types
    adapter.ts              # SessionAdapter interface, IndexState, FreshnessResult
    tools.ts                # Tool param/response types, ToolResponse<T>
    llm.ts                  # LocalLlm request/response types
    common.ts               # Pagination, DateRange, ResponseMeta

  adapters/
    claude-code/
      session-discovery.ts
      conversation-parser.ts
      subagent-parser.ts
      tool-result-resolver.ts
      file-change-extractor.ts
      memory-reader.ts
      config-reader.ts
      index.ts              # ClaudeCodeAdapter implementing SessionAdapter

  services/
    adapter-registry.ts
    index-manager.ts
    search-index.ts
    freshness-guard.ts
    token-budget-manager.ts
    pagination-manager.ts
    summary-service.ts
    local-llm-client.ts
    project-resolver.ts
    analyzer.ts
    response-formatter.ts

  tools/
    list-projects.ts
    get-project.ts
    list-sessions.ts
    get-session.ts
    get-conversation.ts
    search.ts
    get-changes.ts
    get-memory.ts
    analyze.ts
    index.ts                # Registers all tools with MCP server

  infrastructure/
    database.ts             # SQLite connection, WAL mode, pragmas
    http-client.ts          # Base HTTP for local LLM
    file-system.ts          # Async file helpers

  container/
    modules.ts              # tsyringe module registration
    tokens.ts               # DI injection tokens
    index.ts                # Container bootstrap

  server.ts                 # MCP server entrypoint, stdio transport
```

~35 files. Each well under 1200-line limit. Test files colocated: `foo.test.ts` next to `foo.ts`.

## Testing Strategy

**Unit tests** — pure logic, no I/O:
- ConversationParser, TokenBudgetManager, ProjectResolver, PaginationManager, FileChangeExtractor
- Mock only at DI boundaries

**Integration tests** — real SQLite, real file parsing:
- IndexManager, SearchIndex, FreshnessGuard, ClaudeCodeAdapter, SummaryService
- Use fixture JSONL files

**E2E tests** — MCP protocol:
- Spin up server with fixture `~/.claude/` directory
- Call tools through MCP, verify responses, pagination, freshness

**Test fixtures:**
- Sanitized JSONL sessions, memory files, settings in `fixtures/`
- Cover version differences (old/new agent ID formats, with/without meta.json)

**Live testing:**
- `tsx --watch` as MCP server entrypoint for hot reload
- Claude Code MCP config points at dev server
- Test by actually using tools in a Claude session

## Tech Stack

- TypeScript (strict, ESM only, no .js extensions on imports)
- `tsx` for direct execution — no build/transpile step
- `@modelcontextprotocol/sdk` for MCP protocol
- `tsyringe` + `reflect-metadata` for DI
- `better-sqlite3` for SQLite + FTS5
- `vitest` for testing
- Local LLM at `10.1.10.20:30000/v1` (MiniMax-M2.5-AWQ via vLLM, OpenAI-compatible)

## Versioning

All research and this spec are baselined against Claude Code v2.1.87. Session JSONL includes a `version` field on every message. Adapters handle missing fields gracefully for older versions and log warnings on unknown message types.
