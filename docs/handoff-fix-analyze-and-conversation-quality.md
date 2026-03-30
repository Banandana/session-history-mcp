# Handoff: Fix analyze metrics and conversation output quality

## Context

An evaluation of the MCP tools against 55 real sessions found that the highest-value analysis features are broken or returning noise. The tools that work (list_projects, search, get_memory, costly_sessions, frequent_files) are good. The tools that don't work are the ones that would close the feedback loop described in the project vision.

## P0: Fix `corrections` detection (returns empty — hardcoded false)

**Problem:** `isCorrection` is hardcoded to `false` in `src/adapters/claude-code/conversation-parser.ts` at lines 149 and 196. The `analyze` metric `corrections` queries `WHERE m.is_correction = 1` — which always returns 0 rows. The `get_conversation` `window=corrections` also returns empty for the same reason.

**What a correction looks like in real data:**
- User says: "no, not that" / "DONT WORK AROUND SHIT" / "stop adding everything to a document"
- User gives explicit direction after Claude did the wrong thing
- User re-states an instruction Claude ignored

**Implementation approach:**
Correction detection needs to happen in `conversation-parser.ts` during message assembly. A user message is a correction when:
1. It follows an assistant message (not a tool result)
2. It contains negation/redirection language — heuristics like:
   - Starts with "no" / "stop" / "don't" / "not that"
   - Contains "wrong" / "I said" / "I told you" / "should have"
   - Is short (< 50 chars) and imperative tone
3. OR: the assistant's next message after the user message contains self-correction language ("my bad", "you're right", "I should have")

This doesn't need to be perfect — false positives are acceptable, false negatives (missing real corrections) are not. Lean toward over-detecting.

**Files to modify:**
- `src/adapters/claude-code/conversation-parser.ts` — add correction detection logic in `parseSession()` user message handling (around line 196)
- Consider a two-pass approach: first pass assembles messages, second pass marks corrections based on user→assistant→assistant-response patterns

**Test against real data:** Session `79f9fbce` (chai-board) has known corrections:
- "DONT WORK AROUND SHIT EVER" 
- "there are batch mcp tools for kicad too. anything 'tiring' you describe, stop being a fucking idiot"
- "this repo should have remote as git@github.com:Banandana/chai-board.git and push"

Session `105121ef` (KiCAD MCP) has: "no, not that"

Run the indexer against these sessions and verify `is_correction` gets set to `1` on the right messages.

## P0: Fix `tool_failures` detection (returns empty)

**Problem:** The SQL in `src/services/analyzer.ts` lines 120-163 queries `WHERE m.is_error = 1 AND m.has_tool_use = 1 AND m.tool_names IS NOT NULL`. This looks correct in theory, but returns 0 rows.

**Root cause hypothesis:** `is_error` is set on **user messages** (tool_result blocks), but `has_tool_use` and `tool_names` are set on **assistant messages** (tool_use blocks). The error and the tool name are on different messages — the JOIN never matches.

**Fix:** The query needs to correlate tool_result errors back to the assistant message that made the tool call. Options:
1. During indexing, when a user message has `is_error=1` and contains a `tool_result` block, look up the `tool_use_id` and find the corresponding assistant message's `tool_names`. Store `tool_names` on the error message too.
2. Or: change the SQL to JOIN user error messages with the preceding assistant message's tool_names.

**Files to modify:**
- `src/services/analyzer.ts` lines 120-163 — fix the SQL query
- Possibly `src/adapters/claude-code/conversation-parser.ts` — propagate tool name to error messages during parsing
- `src/services/freshness-guard.ts` — if changing what gets indexed

**Test:** Session `c0a7db19` (KiCAD MCP Server) has 148 errors, many of which are Read tool failures. After fix, `tool_failures` should return something like `{"Read": 80, "Bash": 15, ...}`.

## P1: Add structured session summary to `get_session`

**Problem:** There's no way to get "what happened in this session" without reading raw conversation. The `summary_text` column exists in the `sessions` table but is never populated (always null). The `summaries` table also exists but is empty.

**What a useful summary looks like:**
```
{
  "firstUserMessage": "do we have a POC board spec ready",
  "lastUserMessage": "update claude.md with info which will make future sessions pick up from this point",
  "topicEstimate": "chai-board POC schematic design",
  "filesCreated": ["docs/superpowers/specs/2026-03-28-poc-board-design.md", ...],
  "filesEdited": ["CLAUDE.md", ...],
  "errorCount": 78,
  "correctionCount": 5,
  "toolsUsed": {"mcp__kicad__add_schematic_component": 42, "Read": 31, ...},
  "subagentCount": 15,
  "durationMinutes": 485
}
```

**No LLM needed.** This is all extractable from indexed data:
- First/last user text messages (skip tool_results)
- File changes already indexed
- Error/correction counts from messages table
- Tool usage from `tool_names` column aggregation
- Duration from first to last message timestamp
- Subagent count from subagents table

**Files to modify:**
- `src/services/` — add a `session-summarizer.ts` service or extend the existing session query
- `src/tools/` — modify the get_session tool handler to include summary fields in the response

## P2: Clean up `get_conversation` error window output

**Problem:** `window=errors` returns raw message blocks including full `tool_use` input JSON, `thinking` blocks with base64 signatures, and empty `tool_result` stubs. For a session with 148 errors, this produces a massive wall of low-signal data.

**What it returns now:**
```json
{
  "contentBlocks": [
    {"type": "thinking", "thinking": "", "signature": "Eo8CCkYICxgC..."},
    {"type": "tool_use", "id": "toolu_01...", "name": "Read", "input": {"file_path": "/home/kitty/KiCAD-MCP-Server/src/index.ts"}},
    {"type": "tool_result", "tool_use_id": "toolu_01..."}
  ]
}
```

**What it should return:**
```json
{
  "contentBlocks": [
    {"type": "tool_error", "toolName": "Read", "input_summary": "file_path: /home/.../index.ts", "error": "File not found"},
    {"type": "text", "text": "The output is huge — let me get the key sections."}
  ]
}
```

**Changes:**
- Strip thinking blocks entirely from error/correction windows
- For tool_use blocks in error context: collapse to tool name + summarized input (just the key params, not full JSON)
- For tool_result error blocks: extract the actual error message from content
- Keep text blocks as-is — those are the useful context

**Files to modify:**
- `src/services/token-budget-manager.ts` — modify the error window builder (lines 123-148) to post-process content blocks before returning

## P3: Populate subagent metadata during indexing

**Problem:** `totalTokens`, `totalTools`, `durationMs`, `model` are all null for every subagent. The `SubagentParser` at `src/adapters/claude-code/subagent-parser.ts` only reads `.meta.json` which doesn't have this data.

**Where the data lives:** Subagent conversation data is in `agent-{id}.jsonl` files (same format as main session JSONL). The token counts, tool usage, and duration can be computed by parsing these files the same way main sessions are parsed.

**Fix:**
- In `subagent-parser.ts`, after reading `.meta.json`, also parse `agent-{id}.jsonl` to compute:
  - `totalTokens`: sum of all `tokenUsage` fields
  - `totalTools`: count of `tool_use` content blocks
  - `durationMs`: last timestamp - first timestamp
  - `model`: from first assistant message's `model` field
- This is the same parsing logic already in `conversation-parser.ts` — reuse it

**Files to modify:**
- `src/adapters/claude-code/subagent-parser.ts` — extend to parse JSONL files
- Possibly `src/adapters/claude-code/conversation-parser.ts` — extract a reusable token/tool counting utility

## Testing

After each fix, verify against real session data:

```bash
# Re-index everything (drop and rebuild)
rm ~/.claude/session-mcp-index.db
npm run dev
# Then from another Claude Code session, call the MCP tools:
# - analyze with metric=corrections → should return non-empty
# - analyze with metric=tool_failures → should return non-empty  
# - get_session with detail=metadata → should have summary fields
# - get_conversation window=errors → should be clean, no thinking blocks
```

Key test sessions:
- `c0a7db19` — 148 errors, 311K tokens, KiCAD MCP Server (tool failures, Read errors)
- `79f9fbce` — 78 errors, 302K tokens, chai-board (user corrections, MCP workaround frustration)
- `7a136d3e` — 55 errors, 472K tokens, minimal-stm32f (highest token session)
- `ffa5f0a2` — self-views project (conversation mode, user corrections about over-documenting)
