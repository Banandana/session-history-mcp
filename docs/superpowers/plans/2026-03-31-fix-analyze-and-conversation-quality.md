# Fix Analyze Metrics & Conversation Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all broken analyze metrics (corrections, tool_failures), add structured session summaries, clean up noisy conversation output, and populate subagent metadata.

**Architecture:** Five independent fixes across the parser→indexer→query pipeline. P0 fixes modify conversation-parser.ts (correction detection heuristics, tool name propagation to error messages) and analyzer.ts SQL. P1 adds a computed summary to get_session. P2 post-processes content blocks in token-budget-manager.ts. P3 extends subagent-parser.ts to read JSONL files.

**Tech Stack:** TypeScript, better-sqlite3, vitest

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/adapters/claude-code/conversation-parser.ts` | Modify | Add correction detection heuristics, propagate tool names to error user messages |
| `src/adapters/claude-code/conversation-parser.test.ts` | Modify | Add tests for correction detection and tool-name propagation |
| `src/services/analyzer.ts` | Modify | Fix tool_failures SQL to use propagated tool names on error messages |
| `src/services/analyzer.test.ts` | Modify | Add test for tool_failures returning results |
| `src/services/token-budget-manager.ts` | Modify | Strip thinking blocks, collapse tool_use, extract error messages in error/correction windows |
| `src/services/token-budget-manager.test.ts` | Modify | Add tests for cleaned error window output |
| `src/tools/get-session.ts` | Modify | Add computed summary fields to metadata/full detail levels |
| `src/adapters/claude-code/subagent-parser.ts` | Modify | Parse agent-*.jsonl to compute totalTokens, totalTools, durationMs, model |
| `src/adapters/claude-code/subagent-parser.test.ts` | Modify | Add tests for JSONL-derived metadata |
| `fixtures/claude-home/projects/-home-test-project-alpha/dddddddd-1111-2222-3333-444444444444.jsonl` | Create | Fixture with corrections, tool errors with tool_use_id correlation |
| `fixtures/claude-home/projects/-home-test-project-alpha/dddddddd-1111-2222-3333-444444444444/subagents/agent-abc123.jsonl` | Create | Subagent fixture with token usage, tools, timestamps |
| `fixtures/claude-home/projects/-home-test-project-alpha/dddddddd-1111-2222-3333-444444444444/subagents/agent-abc123.meta.json` | Create | Subagent meta fixture |

---

## Task 1: Create test fixture with corrections and tool errors

**Files:**
- Create: `fixtures/claude-home/projects/-home-test-project-alpha/dddddddd-1111-2222-3333-444444444444.jsonl`
- Create: `fixtures/claude-home/projects/-home-test-project-alpha/dddddddd-1111-2222-3333-444444444444/subagents/agent-abc123.jsonl`
- Create: `fixtures/claude-home/projects/-home-test-project-alpha/dddddddd-1111-2222-3333-444444444444/subagents/agent-abc123.meta.json`

- [ ] **Step 1: Create the main session fixture JSONL**

This fixture needs:
- A normal user→assistant exchange (baseline)
- A user correction message ("no, not that — I said use the database module")
- An assistant message with tool_use (Read tool, id: "toolu_01abc")
- A user message with tool_result error (tool_use_id: "toolu_01abc", is_error: true, content: "File not found: /src/missing.ts")
- Another assistant tool_use (Bash, id: "toolu_02def") followed by user tool_result with stderr
- A short imperative correction ("stop, don't do that")
- A thinking block with signature (for P2 noise testing)

```jsonl
{"parentUuid":null,"type":"user","message":{"role":"user","content":"Refactor the auth service"},"uuid":"dd-msg-1","timestamp":"2026-03-28T10:00:01Z","sessionId":"dddddddd-1111-2222-3333-444444444444"}
{"parentUuid":"dd-msg-1","message":{"model":"claude-opus-4-6","id":"dd-resp-1","type":"message","role":"assistant","content":[{"type":"text","text":"I'll refactor the auth service by updating the imports."}],"stop_reason":"end_turn","usage":{"input_tokens":100,"output_tokens":50}},"requestId":"req-dd-1","type":"assistant","uuid":"dd-msg-2","timestamp":"2026-03-28T10:00:05Z","sessionId":"dddddddd-1111-2222-3333-444444444444"}
{"parentUuid":"dd-msg-2","type":"user","message":{"role":"user","content":"no, not that — I said use the database module"},"uuid":"dd-msg-3","timestamp":"2026-03-28T10:00:10Z","sessionId":"dddddddd-1111-2222-3333-444444444444"}
{"parentUuid":"dd-msg-3","message":{"model":"claude-opus-4-6","id":"dd-resp-2","type":"message","role":"assistant","content":[{"type":"thinking","thinking":"","signature":"Eo8BCkYIAx"},{"type":"text","text":"You're right, let me use the database module instead."},{"type":"tool_use","id":"toolu_01abc","name":"Read","input":{"file_path":"/src/missing.ts"}}],"stop_reason":"tool_use","usage":{"input_tokens":200,"output_tokens":120}},"requestId":"req-dd-2","type":"assistant","uuid":"dd-msg-4","timestamp":"2026-03-28T10:00:15Z","sessionId":"dddddddd-1111-2222-3333-444444444444"}
{"parentUuid":"dd-msg-4","type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_01abc","content":"Error: File not found: /src/missing.ts","is_error":true}]},"uuid":"dd-msg-5","timestamp":"2026-03-28T10:00:16Z","sessionId":"dddddddd-1111-2222-3333-444444444444"}
{"parentUuid":"dd-msg-5","message":{"model":"claude-opus-4-6","id":"dd-resp-3","type":"message","role":"assistant","content":[{"type":"text","text":"Let me try a different path."},{"type":"tool_use","id":"toolu_02def","name":"Bash","input":{"command":"cat /src/also-missing.ts"}}],"stop_reason":"tool_use","usage":{"input_tokens":300,"output_tokens":80}},"requestId":"req-dd-3","type":"assistant","uuid":"dd-msg-6","timestamp":"2026-03-28T10:00:20Z","sessionId":"dddddddd-1111-2222-3333-444444444444"}
{"parentUuid":"dd-msg-6","type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_02def","content":{"stderr":"cat: /src/also-missing.ts: No such file or directory","stdout":""}}]},"uuid":"dd-msg-7","timestamp":"2026-03-28T10:00:21Z","sessionId":"dddddddd-1111-2222-3333-444444444444"}
{"parentUuid":"dd-msg-7","message":{"model":"claude-opus-4-6","id":"dd-resp-4","type":"message","role":"assistant","content":[{"type":"text","text":"I'll search for the correct file location."}],"stop_reason":"end_turn","usage":{"input_tokens":400,"output_tokens":30}},"requestId":"req-dd-4","type":"assistant","uuid":"dd-msg-8","timestamp":"2026-03-28T10:00:25Z","sessionId":"dddddddd-1111-2222-3333-444444444444"}
{"parentUuid":"dd-msg-8","type":"user","message":{"role":"user","content":"stop, don't do that"},"uuid":"dd-msg-9","timestamp":"2026-03-28T10:00:30Z","sessionId":"dddddddd-1111-2222-3333-444444444444"}
{"parentUuid":"dd-msg-9","message":{"model":"claude-opus-4-6","id":"dd-resp-5","type":"message","role":"assistant","content":[{"type":"text","text":"Understood, I'll stop."}],"stop_reason":"end_turn","usage":{"input_tokens":450,"output_tokens":10}},"requestId":"req-dd-5","type":"assistant","uuid":"dd-msg-10","timestamp":"2026-03-28T10:00:35Z","sessionId":"dddddddd-1111-2222-3333-444444444444"}
```

- [ ] **Step 2: Create the subagent meta.json fixture**

```json
{
  "agentType": "general-purpose",
  "description": "Explore auth module",
  "model": "claude-sonnet-4-6"
}
```

- [ ] **Step 3: Create the subagent JSONL fixture**

```jsonl
{"type":"user","message":{"role":"user","content":"Find the auth module"},"uuid":"sa-msg-1","timestamp":"2026-03-28T10:01:00Z"}
{"message":{"model":"claude-sonnet-4-6","id":"sa-resp-1","role":"assistant","content":[{"type":"tool_use","id":"sa-tool-1","name":"Glob","input":{"pattern":"**/auth*"}}],"usage":{"input_tokens":50,"output_tokens":30}},"requestId":"sa-req-1","type":"assistant","uuid":"sa-msg-2","timestamp":"2026-03-28T10:01:05Z"}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"sa-tool-1","content":"src/auth.ts\nsrc/auth.test.ts"}]},"uuid":"sa-msg-3","timestamp":"2026-03-28T10:01:06Z"}
{"message":{"model":"claude-sonnet-4-6","id":"sa-resp-2","role":"assistant","content":[{"type":"tool_use","id":"sa-tool-2","name":"Read","input":{"file_path":"src/auth.ts"}}],"usage":{"input_tokens":80,"output_tokens":20}},"requestId":"sa-req-2","type":"assistant","uuid":"sa-msg-4","timestamp":"2026-03-28T10:01:10Z"}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"sa-tool-2","content":"export function authenticate() {}"}]},"uuid":"sa-msg-5","timestamp":"2026-03-28T10:01:11Z"}
{"message":{"model":"claude-sonnet-4-6","id":"sa-resp-3","role":"assistant","content":[{"type":"text","text":"Found the auth module at src/auth.ts"}],"usage":{"input_tokens":100,"output_tokens":15}},"requestId":"sa-req-3","type":"assistant","uuid":"sa-msg-6","timestamp":"2026-03-28T10:01:15Z"}
```

- [ ] **Step 4: Verify fixtures are valid JSON**

Run: `cd /home/kitty/Desktop/claude-session-mcp && node -e "const fs=require('fs'); const lines=fs.readFileSync('fixtures/claude-home/projects/-home-test-project-alpha/dddddddd-1111-2222-3333-444444444444.jsonl','utf8').trim().split('\n'); lines.forEach((l,i) => { try { JSON.parse(l) } catch(e) { console.error('Line '+(i+1)+': '+e.message) } }); console.log(lines.length + ' lines OK')"`
Expected: `10 lines OK`

---

## Task 2: P0 — Correction detection in conversation-parser.ts

**Files:**
- Modify: `src/adapters/claude-code/conversation-parser.ts:177-201` (user message handling)
- Test: `src/adapters/claude-code/conversation-parser.test.ts`

- [ ] **Step 1: Write failing tests for correction detection**

Add to `conversation-parser.test.ts`:

```typescript
describe('correction detection (dddddddd)', () => {
  const sessionPath = join(FIXTURES, 'dddddddd-1111-2222-3333-444444444444.jsonl')

  it('detects "no, not that" as a correction', async () => {
    const messages = await collectMessages(parser, sessionPath)
    const msg3 = messages.find(m => m.uuid === 'dd-msg-3')!
    expect(msg3.isCorrection).toBe(true)
  })

  it('detects "stop, don\'t do that" as a correction', async () => {
    const messages = await collectMessages(parser, sessionPath)
    const msg9 = messages.find(m => m.uuid === 'dd-msg-9')!
    expect(msg9.isCorrection).toBe(true)
  })

  it('does not mark normal user messages as corrections', async () => {
    const messages = await collectMessages(parser, sessionPath)
    const msg1 = messages.find(m => m.uuid === 'dd-msg-1')!
    expect(msg1.isCorrection).toBe(false)
  })

  it('does not mark tool_result messages as corrections', async () => {
    const messages = await collectMessages(parser, sessionPath)
    const msg5 = messages.find(m => m.uuid === 'dd-msg-5')!
    expect(msg5.isCorrection).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/kitty/Desktop/claude-session-mcp && npx vitest run src/adapters/claude-code/conversation-parser.test.ts`
Expected: 2 failures on isCorrection assertions (detects "no, not that" and "stop, don't do that")

- [ ] **Step 3: Implement correction detection**

In `conversation-parser.ts`, add a `detectCorrection` function before the class definition:

```typescript
/** Heuristic: is this user text message a correction of the preceding assistant turn? */
function detectCorrection(contentBlocks: readonly ContentBlock[]): boolean {
  // Only detect on text messages, not tool_results
  if (contentBlocks.length === 0) return false
  const firstBlock = contentBlocks[0]
  if (firstBlock.type !== 'text' || !firstBlock.text) return false

  const text = firstBlock.text.trim().toLowerCase()
  if (text.length === 0) return false

  // Pattern 1: Starts with negation/redirection
  const negationStarts = /^(no[,.\s!]|stop[,.\s!]|don'?t\s|not that|wrong|nope|that'?s not|i said|i told you|should have|you should have)/
  if (negationStarts.test(text)) return true

  // Pattern 2: Correction keywords anywhere in message
  const correctionKeywords = /\b(wrong|don'?t|not that|i said|i told you|should have|you should have|instead of|actually no|stop being|stop doing|stop adding)\b/
  if (correctionKeywords.test(text)) return true

  // Pattern 3: ALL CAPS messages with 4+ consecutive caps (anger/emphasis)
  if (text.toUpperCase() === text && /[A-Z]{4,}/.test(firstBlock.text!.trim())) {
    return true
  }

  return false
}
```

Then modify the user message yield at line 196 — change `isCorrection: false` to:

```typescript
isCorrection: isToolResult ? false : detectCorrection(blocks),
```

The `isToolResult` check is already computed at line 186. Tool results are never corrections — only human-typed text messages can be.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/kitty/Desktop/claude-session-mcp && npx vitest run src/adapters/claude-code/conversation-parser.test.ts`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add src/adapters/claude-code/conversation-parser.ts src/adapters/claude-code/conversation-parser.test.ts fixtures/claude-home/projects/-home-test-project-alpha/dddddddd-*
git commit -m "feat: add correction detection heuristics in conversation parser

Detect user corrections via negation-start patterns, short imperative
keywords, and ALL CAPS emphasis. Tool results are excluded."
```

---

## Task 3: P0 — Propagate tool names to error messages & fix tool_failures SQL

**Files:**
- Modify: `src/adapters/claude-code/conversation-parser.ts:177-201` (user message handling)
- Modify: `src/services/analyzer.ts:120-163` (tool_failures SQL)
- Test: `src/adapters/claude-code/conversation-parser.test.ts`
- Test: `src/services/analyzer.test.ts`

The strategy: when a user message contains `tool_result` blocks, resolve each `tool_use_id` back to the tool name from the most recent assistant message's content blocks. Store those tool names on the user message. Then the existing SQL `WHERE is_error = 1 AND tool_names IS NOT NULL` works (drop the `has_tool_use` condition).

- [ ] **Step 1: Write failing test for tool name propagation**

Add to `conversation-parser.test.ts`:

```typescript
describe('tool name propagation to error messages (dddddddd)', () => {
  const sessionPath = join(FIXTURES, 'dddddddd-1111-2222-3333-444444444444.jsonl')

  it('propagates tool name from assistant tool_use to user tool_result error', async () => {
    const messages = await collectMessages(parser, sessionPath)
    const msg5 = messages.find(m => m.uuid === 'dd-msg-5')!
    expect(msg5.isError).toBe(true)
    expect(msg5.toolNames).toEqual(['Read'])
  })

  it('propagates tool name for stderr errors too', async () => {
    const messages = await collectMessages(parser, sessionPath)
    const msg7 = messages.find(m => m.uuid === 'dd-msg-7')!
    expect(msg7.isError).toBe(true)
    expect(msg7.toolNames).toEqual(['Bash'])
  })

  it('does not set toolNames on non-tool-result user messages', async () => {
    const messages = await collectMessages(parser, sessionPath)
    const msg1 = messages.find(m => m.uuid === 'dd-msg-1')!
    expect(msg1.toolNames).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/kitty/Desktop/claude-session-mcp && npx vitest run src/adapters/claude-code/conversation-parser.test.ts`
Expected: Failures on toolNames assertions for msg5 and msg7

- [ ] **Step 3: Implement tool name propagation in conversation-parser.ts**

Strategy: maintain a `Map<string, string>` of `tool_use_id → tool_name` from the most recent assistant content blocks. When processing a user message with tool_result blocks, look up each tool_use_id to resolve the tool name.

In `parseSession()`, add before the for-loop (after `let pending`):

```typescript
// Map tool_use_id → tool_name from the most recent assistant turn's tool_use blocks
const toolUseIdToName = new Map<string, string>()
```

After flushing a pending assistant, update the map. There are **three flush locations** in `parseSession()` — all three need the map update:
1. **Line 179-182**: flush before yielding a user message (critical — this is where tool_result follows tool_use)
2. **Line 221-222**: flush when a different assistant requestId appears
3. **Line 250-252**: end-of-stream flush

After each `yield finalizePending(pending)` call (before setting `pending = null`), add:

```typescript
// Update tool_use_id map from the flushed assistant's content blocks
for (const block of pending.contentBlocks) {
  if (block.type === 'tool_use' && block.id && block.name) {
    toolUseIdToName.set(block.id, block.name)
  }
}
```

Then in the user message section, after computing `blocks` and `isError`, resolve tool names:

```typescript
// Resolve tool names from tool_result blocks back to the originating tool_use
const resolvedToolNames: string[] = []
if (isToolResult) {
  for (const block of blocks) {
    if (block.type === 'tool_result' && block.tool_use_id) {
      const name = toolUseIdToName.get(block.tool_use_id)
      if (name) resolvedToolNames.push(name)
    }
  }
}
```

And change the yield to include:

```typescript
toolNames: resolvedToolNames.length > 0 ? resolvedToolNames : undefined,
```

- [ ] **Step 4: Run parser tests to verify they pass**

Run: `cd /home/kitty/Desktop/claude-session-mcp && npx vitest run src/adapters/claude-code/conversation-parser.test.ts`
Expected: All tests pass

- [ ] **Step 5: Fix the tool_failures SQL in analyzer.ts**

In `src/services/analyzer.ts`, the `analyzeToolFailures` method (around line 120-163). The current WHERE clause is:

```sql
WHERE m.is_error = 1 AND m.has_tool_use = 1 AND m.tool_names IS NOT NULL
```

Now that tool names are propagated to error user messages, we need to change the condition. The `has_tool_use` column is set based on `toolNames.length > 0` in freshness-guard.ts line 114, so it will be `1` for error messages that have propagated tool names. But to be safe, simplify to:

```sql
WHERE m.is_error = 1 AND m.tool_names IS NOT NULL
```

This works because `tool_names` on user messages will only be non-null when we successfully resolved tool names from tool_result blocks.

- [ ] **Step 6: Write test for tool_failures metric**

In `analyzer.test.ts`, add a test that inserts messages with the new propagated fields and verifies the query returns results. Check the existing test pattern in that file and follow it.

- [ ] **Step 7: Run all tests**

Run: `cd /home/kitty/Desktop/claude-session-mcp && npx vitest run`
Expected: All tests pass

- [ ] **Step 8: Commit**

```bash
git add src/adapters/claude-code/conversation-parser.ts src/adapters/claude-code/conversation-parser.test.ts src/services/analyzer.ts src/services/analyzer.test.ts
git commit -m "fix: propagate tool names to error messages and fix tool_failures query

Resolve tool_use_id from tool_result blocks back to the originating
tool name. Drop has_tool_use requirement from tool_failures SQL since
tool_names are now available on error user messages."
```

---

## Task 4: P1 — Structured session summary in get_session

**Files:**
- Modify: `src/tools/get-session.ts`
- No separate test file needed — this is pure SQL aggregation, testable via MCP tool invocation against real data

- [ ] **Step 1: Add computed summary SQL to get-session.ts**

After the existing `result` object is built (line 59), and within the `detail === 'metadata' || detail === 'full'` block, add computed summary fields:

```typescript
// Computed summary (no LLM needed — pure SQL aggregation)
const firstUserText = db.prepare(`
  SELECT content_preview FROM messages
  WHERE session_id = ? AND role = 'user' AND content_preview != '' AND has_tool_use = 0
  ORDER BY timestamp ASC LIMIT 1
`).get(params.sessionId) as { content_preview: string } | undefined

const lastUserText = db.prepare(`
  SELECT content_preview FROM messages
  WHERE session_id = ? AND role = 'user' AND content_preview != '' AND has_tool_use = 0
  ORDER BY timestamp DESC LIMIT 1
`).get(params.sessionId) as { content_preview: string } | undefined

const errorCount = db.prepare(
  'SELECT COUNT(*) as count FROM messages WHERE session_id = ? AND is_error = 1'
).get(params.sessionId) as { count: number }

const correctionCount = db.prepare(
  'SELECT COUNT(*) as count FROM messages WHERE session_id = ? AND is_correction = 1'
).get(params.sessionId) as { count: number }

const toolUsage = db.prepare(`
  SELECT tool_names FROM messages
  WHERE session_id = ? AND tool_names IS NOT NULL
`).all(params.sessionId) as Array<{ tool_names: string }>

const toolCounts: Record<string, number> = {}
for (const row of toolUsage) {
  for (const name of row.tool_names.split(',')) {
    const trimmed = name.trim()
    if (trimmed) toolCounts[trimmed] = (toolCounts[trimmed] ?? 0) + 1
  }
}

const timestamps = db.prepare(`
  SELECT MIN(timestamp) as first_ts, MAX(timestamp) as last_ts
  FROM messages WHERE session_id = ?
`).get(params.sessionId) as { first_ts: string | null; last_ts: string | null }

const durationMinutes = timestamps.first_ts && timestamps.last_ts
  ? Math.round((new Date(timestamps.last_ts).getTime() - new Date(timestamps.first_ts).getTime()) / 60000)
  : undefined

const subagentCount = db.prepare(
  'SELECT COUNT(*) as count FROM subagents WHERE session_id = ?'
).get(params.sessionId) as { count: number }

result.computedSummary = {
  firstUserMessage: firstUserText?.content_preview,
  lastUserMessage: lastUserText?.content_preview,
  errorCount: errorCount.count,
  correctionCount: correctionCount.count,
  toolsUsed: toolCounts,
  durationMinutes,
  subagentCount: subagentCount.count,
}
```

Note: `has_tool_use = 0` filters out tool_result messages for first/last user text. The `content_preview` column already has the first 200 chars of text — no need to read full content.

- [ ] **Step 2: Run existing tests to ensure nothing breaks**

Run: `cd /home/kitty/Desktop/claude-session-mcp && npx vitest run`
Expected: All existing tests pass

- [ ] **Step 3: Commit**

```bash
git add src/tools/get-session.ts
git commit -m "feat: add computed session summary to get_session metadata

Adds firstUserMessage, lastUserMessage, errorCount, correctionCount,
toolsUsed, durationMinutes, and subagentCount — all from SQL aggregation,
no LLM needed."
```

---

## Task 5: P2 — Clean up error window output in token-budget-manager.ts

**Files:**
- Modify: `src/services/token-budget-manager.ts:123-148` (error window builder)
- Test: `src/services/token-budget-manager.test.ts`

- [ ] **Step 1: Write failing test for cleaned error window**

Add to `token-budget-manager.test.ts`:

```typescript
describe('error window content cleaning', () => {
  it('strips thinking blocks from error window messages', () => {
    const manager = new TokenBudgetManager()
    const messages: NormalizedMessage[] = [
      makeMessage({ id: '1', role: 'assistant', contentBlocks: [
        { type: 'thinking', thinking: '', signature: 'Eo8BCkYIAx' },
        { type: 'text', text: 'Let me read the file.' },
        { type: 'tool_use', id: 'toolu_01', name: 'Read', input: { file_path: '/very/long/path/to/some/deeply/nested/file.ts' } },
      ]}),
      makeMessage({ id: '2', role: 'user', isError: true, contentBlocks: [
        { type: 'tool_result', tool_use_id: 'toolu_01', content: 'Error: File not found: /very/long/path/to/some/deeply/nested/file.ts' },
      ]}),
      makeMessage({ id: '3', role: 'assistant', contentBlocks: [
        { type: 'text', text: 'The file was not found.' },
      ]}),
    ]

    const result = manager.filterByWindow(messages, 'errors')

    // No thinking blocks in output
    for (const msg of result) {
      for (const block of msg.contentBlocks) {
        expect(block.type).not.toBe('thinking')
      }
    }
  })

  it('collapses tool_use input to summary in error window', () => {
    const manager = new TokenBudgetManager()
    const messages: NormalizedMessage[] = [
      makeMessage({ id: '1', role: 'assistant', contentBlocks: [
        { type: 'tool_use', id: 'toolu_01', name: 'Read', input: { file_path: '/src/file.ts' } },
      ]}),
      makeMessage({ id: '2', role: 'user', isError: true, contentBlocks: [
        { type: 'tool_result', tool_use_id: 'toolu_01', content: 'Error: File not found' },
      ]}),
    ]

    const result = manager.filterByWindow(messages, 'errors')
    const assistantMsg = result.find(m => m.role === 'assistant')!
    const toolBlock = assistantMsg.contentBlocks.find(b => b.type === 'tool_use')!
    // Input should be collapsed — not the full object
    expect(typeof toolBlock.input).toBe('string')
  })
})
```

Note: `makeMessage` is a test helper — check if one exists in the test file already. If not, create a minimal factory.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/kitty/Desktop/claude-session-mcp && npx vitest run src/services/token-budget-manager.test.ts`
Expected: Failures on the two new tests

- [ ] **Step 3: Implement content block cleaning**

Add a private method to `TokenBudgetManager`:

```typescript
/** Clean content blocks for error/correction windows — strip noise, keep signal. */
private cleanContentBlocks(blocks: readonly ContentBlock[]): ContentBlock[] {
  const cleaned: ContentBlock[] = []
  for (const block of blocks) {
    // Strip thinking blocks entirely
    if (block.type === 'thinking') continue

    // Collapse tool_use input to key params summary
    if (block.type === 'tool_use') {
      const inputSummary = block.input
        ? Object.entries(block.input as Record<string, unknown>)
            .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
            .join(', ')
            .slice(0, 200)
        : undefined
      cleaned.push({ type: 'tool_use', id: block.id, name: block.name, input: inputSummary as unknown })
      continue
    }

    // Extract error message from tool_result blocks
    if (block.type === 'tool_result') {
      let errorText: string | undefined
      if (typeof block.content === 'string') {
        errorText = block.content
      } else if (block.content && typeof block.content === 'object') {
        const obj = block.content as Record<string, unknown>
        if (obj.stderr && String(obj.stderr).trim()) {
          errorText = String(obj.stderr).trim()
        } else {
          errorText = JSON.stringify(block.content).slice(0, 300)
        }
      }
      cleaned.push({ type: 'tool_result', tool_use_id: block.tool_use_id, content: errorText })
      continue
    }

    // Text blocks pass through unchanged
    cleaned.push(block)
  }
  return cleaned
}
```

Then in `filterByWindow`, after building the `errors` and `corrections` windows (before returning), apply cleaning. Modify both the errors window (around line 148) and corrections window (around line 178). Before the `return filtered` at the end of each window case, map the messages:

```typescript
return result.map(msg => ({
  ...msg,
  contentBlocks: this.cleanContentBlocks(msg.contentBlocks),
}))
```

Note: `NormalizedMessage` has `readonly contentBlocks`. Since `filterByWindow` already returns `NormalizedMessage[]`, you need to create new objects with cleaned blocks. The spread + override pattern works since the return type is the same interface.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/kitty/Desktop/claude-session-mcp && npx vitest run src/services/token-budget-manager.test.ts`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add src/services/token-budget-manager.ts src/services/token-budget-manager.test.ts
git commit -m "fix: clean up error/correction window output

Strip thinking blocks, collapse tool_use input to key param summary,
extract error text from tool_result content. Reduces noise in
get_conversation window=errors output."
```

---

## Task 6: P3 — Populate subagent metadata from JSONL

**Files:**
- Modify: `src/adapters/claude-code/subagent-parser.ts`
- Test: `src/adapters/claude-code/subagent-parser.test.ts`

- [ ] **Step 1: Write failing test for JSONL-derived metadata**

Add to `subagent-parser.test.ts`:

```typescript
describe('JSONL-derived metadata', () => {
  it('computes totalTokens from JSONL token usage', async () => {
    const parser = new SubagentParser(CLAUDE_HOME)
    const subagents = await collectSubagents(parser, '-home-test-project-alpha', 'dddddddd-1111-2222-3333-444444444444')
    const agent = subagents.find(s => s.id === 'abc123')!
    expect(agent).toBeDefined()
    // From fixture: 3 assistant messages with usage (50+30) + (80+20) + (100+15) = 295
    expect(agent.totalTokens).toBe(295)
  })

  it('computes totalTools from tool_use blocks', async () => {
    const parser = new SubagentParser(CLAUDE_HOME)
    const subagents = await collectSubagents(parser, '-home-test-project-alpha', 'dddddddd-1111-2222-3333-444444444444')
    const agent = subagents.find(s => s.id === 'abc123')!
    // From fixture: 2 tool_use blocks (Glob, Read)
    expect(agent.totalTools).toBe(2)
  })

  it('computes durationMs from first to last timestamp', async () => {
    const parser = new SubagentParser(CLAUDE_HOME)
    const subagents = await collectSubagents(parser, '-home-test-project-alpha', 'dddddddd-1111-2222-3333-444444444444')
    const agent = subagents.find(s => s.id === 'abc123')!
    // From fixture: 10:01:00Z to 10:01:15Z = 15000ms
    expect(agent.durationMs).toBe(15000)
  })

  it('extracts model from first assistant message', async () => {
    const parser = new SubagentParser(CLAUDE_HOME)
    const subagents = await collectSubagents(parser, '-home-test-project-alpha', 'dddddddd-1111-2222-3333-444444444444')
    const agent = subagents.find(s => s.id === 'abc123')!
    expect(agent.model).toBe('claude-sonnet-4-6')
  })
})
```

Note: Check existing test helpers (CLAUDE_HOME path, collectSubagents). If `collectSubagents` doesn't exist, create it analogous to `collectMessages` in the conversation parser tests.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/kitty/Desktop/claude-session-mcp && npx vitest run src/adapters/claude-code/subagent-parser.test.ts`
Expected: Failures on totalTokens, totalTools, durationMs, model

- [ ] **Step 3: Implement JSONL parsing in subagent-parser.ts**

Extend `SubagentParser.getSubagents()` to parse the `agent-{id}.jsonl` file after reading `.meta.json`. Add a private method:

```typescript
private async computeJsonlStats(jsonlPath: string): Promise<{
  totalTokens: number
  totalTools: number
  durationMs: number | undefined
  model: string | undefined
}> {
  let totalTokens = 0
  let totalTools = 0
  let firstTimestamp: string | undefined
  let lastTimestamp: string | undefined
  let model: string | undefined

  for await (const { line } of streamJsonlLines(jsonlPath)) {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }

    const timestamp = parsed.timestamp as string | undefined
    if (timestamp) {
      if (!firstTimestamp) firstTimestamp = timestamp
      lastTimestamp = timestamp
    }

    const message = parsed.message as Record<string, unknown> | undefined
    if (!message) continue

    // Extract model from first assistant message
    if (parsed.type === 'assistant' && !model && message.model) {
      model = message.model as string
    }

    // Sum token usage
    const usage = message.usage as Record<string, number> | undefined
    if (usage) {
      totalTokens += (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0)
    }

    // Count tool_use blocks
    const content = message.content
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === 'object' && (block as Record<string, unknown>).type === 'tool_use') {
          totalTools++
        }
      }
    }
  }

  const durationMs = firstTimestamp && lastTimestamp
    ? new Date(lastTimestamp).getTime() - new Date(firstTimestamp).getTime()
    : undefined

  return { totalTokens, totalTools, durationMs, model }
}
```

Add `import { streamJsonlLines } from '../../infrastructure/file-system'` at the top.

In the `getSubagents` method, after resolving the meta file, call `computeJsonlStats`:

```typescript
const jsonlPath = join(subagentsDir, file)
const stats = await this.computeJsonlStats(jsonlPath)

yield {
  id: agentId,
  sessionId,
  agentType: meta?.agentType,
  description: meta?.description,
  totalTokens: stats.totalTokens || undefined,
  totalTools: stats.totalTools || undefined,
  durationMs: stats.durationMs,
  model: stats.model ?? meta?.model,
}
```

Also update the `SubagentMetaFile` interface to include `model`:

```typescript
interface SubagentMetaFile {
  readonly agentType?: string
  readonly description?: string
  readonly model?: string
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/kitty/Desktop/claude-session-mcp && npx vitest run src/adapters/claude-code/subagent-parser.test.ts`
Expected: All tests pass

- [ ] **Step 5: Run the full test suite**

Run: `cd /home/kitty/Desktop/claude-session-mcp && npx vitest run`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add src/adapters/claude-code/subagent-parser.ts src/adapters/claude-code/subagent-parser.test.ts fixtures/
git commit -m "feat: populate subagent metadata from JSONL files

Parse agent-*.jsonl to compute totalTokens, totalTools, durationMs,
and model. Previously only read .meta.json which lacks runtime stats."
```

---

## Task 7: Integration verification & final commit

- [ ] **Step 1: Run full test suite**

Run: `cd /home/kitty/Desktop/claude-session-mcp && npx vitest run`
Expected: All tests pass, no regressions

- [ ] **Step 2: Delete and rebuild the index to test against real data**

Run: `rm -f ~/.claude/session-mcp-index.db`

- [ ] **Step 3: Verify the server starts**

Run: `cd /home/kitty/Desktop/claude-session-mcp && timeout 5 npx tsx src/server.ts 2>&1 || true`
Expected: Server starts without errors (will timeout since it's a stdio server)

- [ ] **Step 4: Final commit if any fixups needed**

Only if tests or integration revealed issues that needed additional changes.
