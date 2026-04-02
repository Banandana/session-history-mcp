# Claude Session MCP Server

MCP server for interfacing with Claude session history. First-class LLM-optimized access through functions designed for efficiency and minimal context consumption.

## Tech Stack & Constraints

- **Language**: TypeScript (strict mode)
- **Module system**: ESM only — no CommonJS, no `.js` extensions on imports
- **No transpiling**: Use `tsx` or similar for direct execution — no build step producing `.js` artifacts
- **SDK**: Official `@modelcontextprotocol/sdk` for MCP protocol implementation
- **DI**: `tsyringe` with `reflect-metadata` for dependency injection and annotation processing
- **Runtime**: Node.js LTS

## Architecture Rules

- **Rich indexing** — All data returned by MCP tools must be self-describing and immediately useful to the caller. Compute metrics, summaries, and labels at index time. Never return raw IDs where human-readable labels can be derived. The caller should never need a follow-up query to understand what a result represents.
- **1200 line max per file** — split before you hit the limit, not after
- **Componentized and layered** — clear separation of concerns across layers
- **DI-based services** — all services registered and resolved through tsyringe containers
- **Type/Interface/Contract separation** — types and interfaces live in dedicated files, not mixed with business logic
- **Business logic isolation** — pure logic separated from infrastructure, transport, and framework concerns
- **Testing at each level** — unit tests for logic, integration tests for services, e2e tests for MCP tool endpoints

## Code Style

- Modern TypeScript idioms — use `satisfies`, `const` assertions, template literal types where appropriate
- No `any` — use `unknown` and narrow, or define proper types
- Barrel exports via `index.ts` per module
- Prefer `interface` over `type` for object shapes that may be extended
- Use `readonly` by default on properties and arrays
- Named exports only — no default exports

## File Organization

```
src/
  types/           # Shared types, interfaces, contracts
  services/        # Business logic services (DI-managed)
  tools/           # MCP tool definitions and handlers
  resources/       # MCP resource definitions
  infrastructure/  # Database, file system, external integrations
  container/       # tsyringe container setup and module registration
  server.ts        # MCP server bootstrap
```

## Testing

- Test files colocated next to source: `foo.ts` -> `foo.test.ts`
- Use `vitest` for test runner
- Mock only at DI boundaries — inject test doubles through the container
- No mocking file system or database in integration tests unless explicitly discussed

## Import Conventions

- No `.js` extensions on TypeScript imports
- Use path aliases if configured (e.g., `@/services/...`)
- Group imports: node builtins, external packages, internal modules (separated by blank lines)

## Development

```bash
npm run dev          # Hot-reload MCP server via tsx --watch
npm run start        # Run MCP server
npm test             # Run all tests
npm run test:watch   # Watch mode tests
```

### MCP Configuration

Add to `~/.claude/settings.local.json` under `mcpServers`:

```json
{
  "mcpServers": {
    "session-history": {
      "command": "npx",
      "args": ["tsx", "/home/kitty/Desktop/claude-session-mcp/src/server.ts"]
    }
  }
}
```

### Available Tools (11)

| Tool | Purpose |
|------|---------|
| `list_projects` | All known projects with metadata |
| `get_project` | Project detail — CLAUDE.md, settings, memory, stats |
| `list_sessions` | Sessions filtered by project/date/branch |
| `get_session` | Session detail — metadata, turns, files, subagents |
| `get_conversation` | Session overview — phase-clustered activity timeline |
| `query_turns` | Search turns by tool name, error status, text pattern, time range |
| `get_turns` | Full content for specific turns — tool inputs, outputs, text |
| `search` | FTS5 full-text search across all sessions |
| `get_changes` | File operations tracked across sessions |
| `get_memory` | Cross-project memory access |
| `analyze` | Pattern discovery — errors, corrections, tool failures |

## Git Rules

- **Never add Co-Authored-By lines** — no Claude co-author tags on commits

## Conversation Navigation (2026-04-01)

Replaced monolithic `get_conversation` with a three-tool navigation flow:

- **`get_conversation`** — Phase-clustered overview. Groups turns by activity category (Error > Modify > Execute > Explore > Discuss). `maxTokens` merges phases and truncates lists to fit budget.
- **`query_turns`** — Structured search within a session (JSONL) or across sessions (DB). Filters: `toolNames`, `isError`, `isCorrection`, `roles`, `textPattern` (single-session only), `timeRange`, `turnRange`. Cross-session queries use `turn_events` DB table with lazy backfill.
- **`get_turns`** — Full content expansion by turn ID or index range (max 50). 4-stage truncation when `maxTokens` set: tool_result content → tool_use input → text blocks → drop middle turns.

Supporting infrastructure:
- `turn_events` table (V2 migration) — per-turn structured data indexed during sync
- `TurnIndexer` service — populates turn_events, integrated into FreshnessGuard sync pipeline
- `PhaseClusterer` service — groups consecutive turns by activity category with singleton absorption
- Removed: `conversation-distiller.ts`, `Focus` type, `filterByWindow`

## Recently Fixed (2026-03-31)

All issues from `docs/handoff-fix-analyze-and-conversation-quality.md` are resolved:

- **P0 `corrections`**: Heuristic detection via negation patterns, correction keywords, ALL CAPS. Tool results excluded.
- **P0 `tool_failures`**: Tool names propagated from `tool_use` to `tool_result` error messages via `tool_use_id` resolution. SQL simplified.
- **P1 Session summaries**: `get_session` with `detail=metadata` now returns `computedSummary` with firstUserMessage, lastUserMessage, errorCount, correctionCount, toolsUsed, durationMinutes, subagentCount.
- **P2 Error window**: Thinking blocks stripped, tool_use input collapsed to key params, tool_result error text extracted.
- **P3 Subagent metadata**: `subagent-parser.ts` now parses `agent-*.jsonl` for totalTokens, totalTools, durationMs, model.
