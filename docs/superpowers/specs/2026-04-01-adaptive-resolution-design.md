# Adaptive Resolution

**Date**: 2026-04-01
**Status**: Approved
**Goal**: Let agent callers control how deeply the MCP analyzes session data, with parameterized distillation and live LLM analysis for targeted deep-dives.
**Depends on**: Rich Session Indexing (2026-04-01-rich-session-indexing-design.md)

## Problem

Pre-computed summaries are one-size-fits-all. An agent scanning 20 sessions to find "where footprints were changed" gets generic narratives that don't help it decide which sessions matter. The only option is to read raw conversations — expensive and slow. The MCP should let the caller specify what lens to look through, so the tool does the analytical work instead of the caller.

## Design Principles

1. **Resolution is intent-driven** — the caller knows what level they need before they ask. It's not progressive disclosure; it's choosing the right tool for the job.
2. **Lists are for scanning, not analysis** — `list_sessions` gives you enough to pick candidates. Deep analysis happens on individual sessions via `get_session`.
3. **Focus is cheap, intent is expensive** — `focus` changes what data is emphasized (structural, no LLM). `intent` triggers live LLM analysis (semantic, always fresh).
4. **High resolution is never cached** — it's an active analysis request, not a stored artifact.

## Parameter Definitions

### `resolution` — controls response density

Only on tools where output volume scales with query scope.

| Value | LLM involved? | Use case |
|-------|---------------|----------|
| `low` | No | Fast scanning. Minimal fields, no summaries. |
| `medium` (default) | No (pre-computed) | Standard browsing. Full metrics + pre-computed summary. |

No `high` on list endpoints. Deep analysis happens on `get_session`.

### `focus` — controls what data is emphasized

Available on `get_session` (detail=full) and `get_conversation`. Changes what the ConversationDistiller preserves vs collapses. Silently ignored when passed with incompatible detail levels (e.g., `detail=summary`).

| Value | Distiller behavior |
|-------|-------------------|
| `general` (default) | Current behavior — user/assistant text kept, tools collapsed to names |
| `tools` | Tool names + key input params preserved: `[mcp__kicad__edit_schematic_component: ref=U5, value=STM32F405]` |
| `errors` | Error messages + user corrections kept verbatim, happy-path tool calls collapsed |
| `files` | File paths from Edit/Write/Read calls emphasized with operation type, other tools collapsed |
| `decisions` | User messages + assistant reasoning text kept in full, tool calls dropped entirely |

At `detail=full` on `get_session`, focus controls what the conversation sample looks like. No LLM needed — just distillation rules.

### `intent` — triggers live LLM analysis

Available on `get_session` (detail=full) only. Free-text string describing what the caller is looking for. Max 500 characters (enforced in Zod schema).

**Minimum message threshold**: If the session has fewer than 3 messages, intent analysis is skipped — returns `analysis: null` with `reason: "too_few_messages"`. Not enough signal for meaningful analysis.

**Edge case — focus=tools with no tool calls**: The distilled output will contain only user/assistant text. The LLM analysis proceeds normally — it may determine the session is not relevant to a tools-focused intent. No special handling needed.

When `intent` is provided:
1. Distiller runs with the specified `focus` (or `general` if not set)
2. LLM receives the distilled conversation + metrics + intent
3. LLM generates a targeted analysis: is this session relevant to the intent? If so, how specifically?
4. Result returned as `analysis` field alongside the conversation sample
5. Never cached — always a fresh LLM call

## Tool Contract Changes

### `list_sessions`

**New parameter:**
- `resolution`: `"low"` | `"medium"` (default `"medium"`)

**Low resolution response shape:**
```json
{
  "id": "ae290dbc-...",
  "startedAt": "2026-03-24T17:31:29Z",
  "endedAt": "2026-03-24T20:56:38Z",
  "durationMinutes": 206,
  "topic": "Full schematic audit — schematic work, code exploration"
}
```

No `summary`, `totalTokens`, `totalTurns`, `messageCount`, `errorCount` at low. Just enough to scan and pick.

**Medium resolution:** Current behavior (unchanged from rich indexing spec).

### `get_session`

**New parameters (on detail=full only):**
- `focus`: `"general"` | `"tools"` | `"errors"` | `"files"` | `"decisions"` (default `"general"`)
- `intent`: free-text string (optional)

**When focus is set (no intent):**
- `conversationSample` is distilled using the specified focus rules
- No LLM call
- Response includes `conversationSample` with focus-appropriate detail

**When intent is set:**
- `conversationSample` is distilled using focus (or general)
- LLM analyzes the session against the intent
- Response includes `analysis` field:

```json
{
  "analysis": {
    "relevant": true,
    "summary": "This session is directly relevant — the user changed U5's footprint from TSSOP-20 to SOIC-20 at 18:42, and reassigned R7/R8/C23 reference designators. The footprint change was triggered by JLC assembly constraints.",
    "generatedAt": "2026-04-01T22:30:00Z"
  }
}
```

If not relevant: `{"relevant": false, "summary": "No footprint changes in this session. Work focused on ERC error resolution and Mouser MCP setup."}`.

### `get_conversation`

**New parameter:**
- `focus`: `"general"` | `"tools"` | `"errors"` | `"files"` | `"decisions"` (default `"general"`)

When `focus` is set and `includeToolResults` is false (default), `get_conversation` runs the selected messages through `distillConversation()` and returns `DistilledMessage[]` in a new `distilled` field alongside the raw `messages` array. The raw messages are still returned (for callers that need them), but the distilled view provides the focus-filtered perspective. When `includeToolResults` is true, focus is ignored — raw content is returned as-is.

**Response shape with focus:**
```json
{
  "messages": [...],
  "distilled": [
    {"role": "user", "text": "do a full audit"},
    {"role": "assistant", "text": "I'll start with ERC"},
    {"role": "action", "text": "[mcp__kicad__run_erc: schematicPath=minimal-stm32f.kicad_sch]"}
  ]
}
```

This avoids a breaking change — `messages` stays the same, `distilled` is additive.

### `search`

No `focus` parameter. Search results come from FTS5 snippets generated inside SQLite — the server doesn't have surrounding message context at search time. Applying focus-based distillation would require fetching surrounding messages per hit, which is a fundamentally different and expensive operation. Deferred to future work if needed.

## ConversationDistiller Changes

The distiller becomes parameterized. The existing `distillConversation(messages, n)` signature changes to accept an options object. **All existing call sites** (`get-session.ts`, `freshness-guard.ts`) must be updated from `distillConversation(messages, 10)` to `distillConversation(messages, { n: 10 })`. New signature:

```typescript
interface DistillOptions {
  readonly n?: number           // bookend count, default 10
  readonly focus?: Focus        // default 'general'
}

type Focus = 'general' | 'tools' | 'errors' | 'files' | 'decisions'

export function distillConversation(
  messages: readonly NormalizedMessage[],
  options?: DistillOptions,
): DistilledConversation
```

### Focus-specific distillation rules

**`general`** (current behavior):
- User text: verbatim, truncated to 500 chars
- Assistant text: verbatim, truncated to 500 chars
- Tool use: collapsed to `[ToolName, ToolName]`
- Tool results: dropped
- Thinking: dropped

**`tools`**:
- User text: verbatim, truncated to 500 chars
- Assistant text: verbatim, truncated to 500 chars
- Tool use: name + key input params extracted: `[Read: src/auth.ts]`, `[Edit: src/auth.ts, lines 45-60]`, `[Bash: npm test]`, `[mcp__kicad__edit_schematic_component: ref=U5, footprint=SOIC-20]`
- Tool results: error results kept (first 200 chars), success results dropped
- Thinking: dropped

**`errors`**:
- First pass: scan message array, mark indices where `isError=true` or `isCorrection=true`
- For each marked index, also mark index-1 and index+1 (context window of 1 message each side)
- Marked messages: kept in full (user/assistant text + tool names + error result text up to 200 chars)
- Unmarked runs of consecutive messages: collapsed to single `{role: 'action', text: '[... 14 messages ...]'}`
- This requires array-index access (not per-message), so implemented as a separate code path from the other focus modes
- Thinking: dropped

**`files`**:
- Tool use with file paths (Read, Write, Edit, Glob, Grep): name + path: `[Edit: src/services/auth.ts]`, `[Read: package.json]`
- Tool use without file paths: collapsed to `[ToolName]`
- User/assistant text: truncated to 200 chars (less important than file operations)
- Tool results: dropped
- Thinking: dropped

**`decisions`**:
- User messages: kept in full (up to 500 chars) — these contain the requirements and corrections
- Assistant text blocks: kept in full (up to 500 chars) — these contain reasoning
- Tool use: dropped entirely (decisions are about the why, not the how)
- Tool results: dropped
- Thinking: dropped

### Extracting tool input params

For `focus=tools`, the distiller needs to extract meaningful params from tool_use input:

```typescript
function extractToolParams(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return name
  const params = input as Record<string, unknown>

  // File tools
  if ('file_path' in params) return `${name}: ${basename(params.file_path as string)}`
  if ('path' in params) return `${name}: ${params.path}`
  if ('pattern' in params) return `${name}: ${params.pattern}`
  if ('command' in params) return `${name}: ${(params.command as string).slice(0, 60)}`

  // MCP tools — extract ref, value, footprint, schematicPath, etc.
  const keys = ['ref', 'value', 'footprint', 'component', 'netName', 'label']
  const extracted = keys.filter(k => k in params).map(k => `${k}=${params[k]}`).join(', ')
  return extracted ? `${name}: ${extracted}` : name
}
```

## LLM Analysis Pipeline (intent)

When `intent` is provided on `get_session` with `detail=full`:

1. Run `distillConversation(messages, { focus, n: 15 })` — slightly larger window for analysis
2. Build prompt:

```
You are analyzing a coding session for a specific purpose.

Caller's intent: {intent}

Session metrics:
- Duration: {duration} min, {turns} turns
- Errors: {errorCount}, Corrections: {correctionCount}
- Tools: {top 5 tools with counts}
- Files changed: {files list}

Conversation ({focus}-focused):
{distilled conversation}

Answer these questions:
1. Is this session relevant to the caller's intent? (yes/no)
2. If relevant, explain specifically how — cite concrete details from the conversation.
3. If not relevant, say what the session was actually about in one sentence.

Be concise. Cite specific details (file names, component refs, error messages) when relevant.
```

3. Parse LLM response into `{relevant: boolean, summary: string}`
4. Return as `analysis` field on the response

**LLM provider**: Uses the existing `LocalLlmClient` (same as index-time summaries). Timeout: 15 seconds (slightly more than the 10s index-time limit, since intent analysis reads a larger window and generates a more targeted response). On failure, return `analysis: null` with the rest of the response intact.

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `src/services/conversation-distiller.ts` | Modify | Add `DistillOptions`, `Focus` type, focus-specific rules, `extractToolParams` |
| `src/services/conversation-distiller.test.ts` | Modify | Add tests for each focus mode |
| `src/tools/list-sessions.ts` | Modify | Add `resolution` param, low-res response shape |
| `src/tools/get-session.ts` | Modify | Add `focus` and `intent` params on detail=full, LLM analysis pipeline |
| `src/tools/get-conversation.ts` | Modify | Add `focus` param, pass to distiller |
| `src/tools/get-session.ts` | Modify | Update `distillConversation` call site for new signature |
| `src/services/freshness-guard.ts` | Modify | Update `distillConversation` call site for new signature |
| `src/types/session.ts` | Modify | Add `Focus` type export, `AnalysisResult` interface |

## Testing

- **ConversationDistiller**: Unit tests per focus mode — verify correct collapsing/preserving behavior for each
- **extractToolParams**: Unit tests with various tool inputs — file paths, MCP params, bare tools
- **list_sessions low**: Verify stripped response shape
- **get_session focus**: Verify conversation sample changes with focus
- **get_session intent**: Mock LLM, verify analysis field populated
- **get_session intent timeout**: Verify graceful degradation when LLM fails

## Future Work (deferred)

- `analyze` metric type `relevance` — batch LLM analysis across multiple sessions ranked by intent
- `resolution=high` on search — LLM re-ranks search results by semantic relevance to query
