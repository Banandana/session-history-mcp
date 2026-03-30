# Adaptive Resolution — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add parameterized distillation (focus modes) and live LLM analysis (intent) so agent callers can control what lens the MCP uses when presenting session data.

**Architecture:** The `distillConversation` function gains a `focus` parameter that changes distillation rules per mode. `get_session` gains `focus`/`intent` for targeted analysis. `list_sessions` gains `resolution` for scanning vs browsing. `get_conversation` gains `focus` for distilled views.

**Tech Stack:** TypeScript (strict), better-sqlite3, tsyringe DI, ESM, vitest

**Spec:** `docs/superpowers/specs/2026-04-01-adaptive-resolution-design.md`

---

### Task 1: Change distillConversation signature to options object

**Files:**
- Modify: `src/services/conversation-distiller.ts:114-117`
- Modify: `src/services/conversation-distiller.test.ts` (all call sites)
- Modify: `src/tools/get-session.ts:119`
- Modify: `src/services/freshness-guard.ts:101`
- Modify: `src/types/session.ts` (add Focus type)

This is a pure refactor — no behavior change. Migrate from positional `n` to options object and add the `Focus` type.

- [ ] **Step 1: Add Focus type to types/session.ts**

Add at the end of `src/types/session.ts`:

```typescript
export type Focus = 'general' | 'tools' | 'errors' | 'files' | 'decisions'
```

- [ ] **Step 2: Update distillConversation signature**

In `src/services/conversation-distiller.ts`, change the export and add the options interface:

```typescript
import type { NormalizedMessage, ContentBlock, Focus } from '../types'

export interface DistillOptions {
  readonly n?: number
  readonly focus?: Focus
}

// Change signature from:
//   export function distillConversation(messages, n = 10)
// To:
export function distillConversation(
  messages: readonly NormalizedMessage[],
  options?: DistillOptions | number,  // Accept number for backward compat during migration
): DistilledConversation {
  const n = typeof options === 'number' ? options : (options?.n ?? 10)
  const selected = selectBookends(messages, n)
  // ... rest unchanged
}
```

Export `DistillOptions` from the barrel at `src/services/index.ts`.

- [ ] **Step 3: Update all call sites**

Change `distillConversation(messages, 10)` to `distillConversation(messages, { n: 10 })` in:
- `src/tools/get-session.ts:119`
- `src/services/freshness-guard.ts:101`

Change test calls that pass a number: `distillConversation(messages, 5)` → `distillConversation(messages, { n: 5 })`

- [ ] **Step 4: Run tests**

Run: `npx vitest run`
Expected: All 243+ tests PASS (pure refactor, no behavior change)

- [ ] **Step 5: Remove number overload**

Now that all call sites use the options object, remove the `| number` union from the signature:

```typescript
export function distillConversation(
  messages: readonly NormalizedMessage[],
  options?: DistillOptions,
): DistilledConversation {
  const n = options?.n ?? 10
```

- [ ] **Step 6: Run tests again and commit**

Run: `npx vitest run`

```bash
git add -A
git commit -m "refactor: change distillConversation to options object, add Focus type"
```

---

### Task 2: Implement focus=tools distillation

**Files:**
- Modify: `src/services/conversation-distiller.ts`
- Modify: `src/services/conversation-distiller.test.ts`

- [ ] **Step 1: Write failing tests for tools focus**

Add to `src/services/conversation-distiller.test.ts`:

```typescript
describe('focus=tools', () => {
  it('extracts tool names with key input params', () => {
    const msgs = [makeMsg({
      id: '1', role: 'assistant',
      contentBlocks: [
        { type: 'text', text: 'Let me check.' },
        { type: 'tool_use', name: 'Read', input: { file_path: '/src/auth.ts' } },
        { type: 'tool_use', name: 'mcp__kicad__edit_schematic_component', input: { ref: 'U5', footprint: 'SOIC-20' } },
      ],
    })]
    const result = distillConversation(msgs, { focus: 'tools' })
    const action = result.messages.find(m => m.role === 'action')
    expect(action).toBeDefined()
    expect(action!.text).toContain('Read: auth.ts')
    expect(action!.text).toContain('ref=U5')
    expect(action!.text).toContain('footprint=SOIC-20')
  })

  it('extracts Bash command preview', () => {
    const msgs = [makeMsg({
      id: '1', role: 'assistant',
      contentBlocks: [
        { type: 'tool_use', name: 'Bash', input: { command: 'npm test -- --coverage' } },
      ],
    })]
    const result = distillConversation(msgs, { focus: 'tools' })
    expect(result.messages[0].text).toContain('Bash: npm test -- --coverage')
  })

  it('keeps error tool results at tools focus', () => {
    const msgs = [makeMsg({
      id: '1', role: 'user',
      contentBlocks: [
        { type: 'tool_result', tool_use_id: 'x', content: 'Error: file not found at /src/missing.ts' }
      ],
      isError: true,
    })]
    const result = distillConversation(msgs, { focus: 'tools' })
    expect(result.messages.length).toBe(1)
    expect(result.messages[0].text).toContain('Error: file not found')
  })

  it('falls back to just tool name when no recognizable params', () => {
    const msgs = [makeMsg({
      id: '1', role: 'assistant',
      contentBlocks: [
        { type: 'tool_use', name: 'ToolSearch', input: { query: 'something' } },
      ],
    })]
    const result = distillConversation(msgs, { focus: 'tools' })
    expect(result.messages[0].text).toContain('ToolSearch')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/services/conversation-distiller.test.ts`
Expected: FAIL — focus not implemented yet

- [ ] **Step 3: Implement extractToolParams and tools focus**

Add to `conversation-distiller.ts`:

```typescript
import { basename } from 'node:path'

function extractToolParams(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return name
  const params = input as Record<string, unknown>

  if ('file_path' in params) return `${name}: ${basename(String(params.file_path))}`
  if ('path' in params) return `${name}: ${params.path}`
  if ('pattern' in params) return `${name}: ${params.pattern}`
  if ('command' in params) return `${name}: ${String(params.command).slice(0, 60)}`

  const keys = ['ref', 'value', 'footprint', 'component', 'netName', 'label']
  const extracted = keys.filter(k => k in params).map(k => `${k}=${params[k]}`).join(', ')
  return extracted ? `${name}: ${extracted}` : name
}
```

Modify `distillMessage` to accept focus and use `extractToolParams` when `focus === 'tools'`. In the `tool_use` block handler:

```typescript
if (block.type === 'tool_use') {
  flushText()
  if (focus === 'tools') {
    toolNames.push(extractToolParams(block.name ?? 'unknown', block.input))
  } else {
    toolNames.push(block.name ?? 'unknown')
  }
  continue
}
```

For `focus=tools`, also keep error tool_results instead of dropping them:

```typescript
if (block.type === 'tool_result') {
  if (focus === 'tools' && message.isError && typeof block.content === 'string') {
    flushTools()
    result.push({ role: 'action', text: truncate(block.content, 200) })
  } else {
    flushTools()
  }
  continue
}
```

Thread `focus` through: `distillConversation` → `distillMessage(message, focus)`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/services/conversation-distiller.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/conversation-distiller.ts src/services/conversation-distiller.test.ts
git commit -m "feat: add focus=tools distillation with extractToolParams"
```

---

### Task 3: Implement focus=errors distillation

**Files:**
- Modify: `src/services/conversation-distiller.ts`
- Modify: `src/services/conversation-distiller.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
describe('focus=errors', () => {
  it('keeps error messages and their context window', () => {
    const msgs = Array.from({ length: 10 }, (_, i) => makeMsg({
      id: String(i), role: i % 2 === 0 ? 'user' : 'assistant',
      contentBlocks: [{ type: 'text', text: `Message ${i}` }],
      isError: i === 5,
    }))
    const result = distillConversation(msgs, { focus: 'errors' })
    // Should have: msg 4 (before), msg 5 (error), msg 6 (after), plus collapse markers
    const texts = result.messages.map(m => m.text)
    expect(texts).toContainEqual('Message 4')
    expect(texts).toContainEqual('Message 5')
    expect(texts).toContainEqual('Message 6')
  })

  it('keeps correction messages in full', () => {
    const msgs = [
      makeMsg({ id: '0', role: 'assistant', contentBlocks: [{ type: 'text', text: 'I did X' }] }),
      makeMsg({ id: '1', role: 'user', contentBlocks: [{ type: 'text', text: 'No, do Y instead' }], isCorrection: true }),
      makeMsg({ id: '2', role: 'assistant', contentBlocks: [{ type: 'text', text: 'OK doing Y' }] }),
    ]
    const result = distillConversation(msgs, { focus: 'errors' })
    expect(result.messages.some(m => m.text === 'No, do Y instead')).toBe(true)
  })

  it('collapses gaps between errors', () => {
    const msgs = Array.from({ length: 20 }, (_, i) => makeMsg({
      id: String(i), role: i % 2 === 0 ? 'user' : 'assistant',
      contentBlocks: [{ type: 'text', text: `Message ${i}` }],
      isError: i === 3 || i === 17,
    }))
    const result = distillConversation(msgs, { focus: 'errors' })
    const collapsed = result.messages.filter(m => m.text.includes('...'))
    expect(collapsed.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement errors focus**

This is a separate code path because it requires array-index windowing, not per-message processing.

Add a new function `distillWithErrorFocus`:

```typescript
function distillWithErrorFocus(
  messages: readonly NormalizedMessage[],
): readonly DistilledMessage[] {
  // Mark which indices to keep
  const keep = new Set<number>()
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].isError || messages[i].isCorrection) {
      if (i > 0) keep.add(i - 1)
      keep.add(i)
      if (i < messages.length - 1) keep.add(i + 1)
    }
  }

  const result: DistilledMessage[] = []
  let gapCount = 0

  for (let i = 0; i < messages.length; i++) {
    if (keep.has(i)) {
      if (gapCount > 0) {
        result.push({ role: 'action', text: `[... ${gapCount} messages ...]` })
        gapCount = 0
      }
      result.push(...distillMessage(messages[i], 'general'))
    } else {
      gapCount++
    }
  }
  if (gapCount > 0) {
    result.push({ role: 'action', text: `[... ${gapCount} messages ...]` })
  }

  return result
}
```

In `distillConversation`, branch on focus before the main loop:

```typescript
if (focus === 'errors') {
  const distilled = distillWithErrorFocus(selected)
  const estimatedTokens = distilled.reduce((sum, m) => sum + Math.floor(m.text.length / 4), 0)
  return { messages: distilled, estimatedTokens }
}
```

- [ ] **Step 4: Run tests**

- [ ] **Step 5: Commit**

```bash
git add src/services/conversation-distiller.ts src/services/conversation-distiller.test.ts
git commit -m "feat: add focus=errors distillation with context windowing"
```

---

### Task 4: Implement focus=files and focus=decisions

**Files:**
- Modify: `src/services/conversation-distiller.ts`
- Modify: `src/services/conversation-distiller.test.ts`

- [ ] **Step 1: Write failing tests for both modes**

```typescript
describe('focus=files', () => {
  it('preserves file paths from file tools', () => {
    const msgs = [makeMsg({
      id: '1', role: 'assistant',
      contentBlocks: [
        { type: 'tool_use', name: 'Edit', input: { file_path: '/src/services/auth.ts' } },
        { type: 'tool_use', name: 'Read', input: { file_path: '/package.json' } },
      ],
    })]
    const result = distillConversation(msgs, { focus: 'files' })
    expect(result.messages[0].text).toContain('Edit: auth.ts')
    expect(result.messages[0].text).toContain('Read: package.json')
  })

  it('collapses non-file tools to just name', () => {
    const msgs = [makeMsg({
      id: '1', role: 'assistant',
      contentBlocks: [
        { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
      ],
    })]
    const result = distillConversation(msgs, { focus: 'files' })
    expect(result.messages[0].text).toBe('[Bash]')
  })

  it('truncates user/assistant text to 200 chars', () => {
    const msgs = [makeMsg({
      id: '1', role: 'user',
      contentBlocks: [{ type: 'text', text: 'a'.repeat(500) }],
    })]
    const result = distillConversation(msgs, { focus: 'files' })
    expect(result.messages[0].text.length).toBeLessThanOrEqual(203)
  })
})

describe('focus=decisions', () => {
  it('keeps user and assistant text, drops tool_use entirely', () => {
    const msgs = [
      makeMsg({ id: '1', role: 'user', contentBlocks: [{ type: 'text', text: 'Add auth to the API' }] }),
      makeMsg({
        id: '2', role: 'assistant',
        contentBlocks: [
          { type: 'text', text: 'I will use JWT tokens for auth.' },
          { type: 'tool_use', name: 'Edit', input: { file_path: '/src/auth.ts' } },
        ],
      }),
    ]
    const result = distillConversation(msgs, { focus: 'decisions' })
    expect(result.messages).toHaveLength(2)
    expect(result.messages[0].text).toBe('Add auth to the API')
    expect(result.messages[1].text).toBe('I will use JWT tokens for auth.')
    expect(result.messages.every(m => m.role !== 'action')).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement files and decisions focus**

In `distillMessage`, add focus-specific behavior:

**files**: Use `extractToolParams` for file tools (Read, Write, Edit, Glob, Grep) — extract `file_path`/`path`. For non-file tools, just the name. Truncate text to 200 chars.

**decisions**: Skip all `tool_use` blocks entirely — don't push to `toolNames`. Keep only text blocks from user/assistant.

The cleanest approach: add focus checks in the existing `distillMessage` block handlers:

```typescript
if (block.type === 'tool_use') {
  if (focus === 'decisions') continue  // Drop tool_use entirely
  flushText()
  const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'Glob', 'Grep'])
  if (focus === 'files' && FILE_TOOLS.has(block.name ?? '')) {
    toolNames.push(extractToolParams(block.name!, block.input))
  } else if (focus === 'tools') {
    toolNames.push(extractToolParams(block.name ?? 'unknown', block.input))
  } else {
    toolNames.push(block.name ?? 'unknown')
  }
  continue
}
```

For `focus=files`, set `MAX_TEXT_LENGTH` to 200 (pass as param or use a local constant based on focus).

- [ ] **Step 4: Run tests**

- [ ] **Step 5: Commit**

```bash
git add src/services/conversation-distiller.ts src/services/conversation-distiller.test.ts
git commit -m "feat: add focus=files and focus=decisions distillation modes"
```

---

### Task 5: Add resolution param to list_sessions

**Files:**
- Modify: `src/tools/list-sessions.ts`

- [ ] **Step 1: Add resolution parameter**

Add to the Zod schema:

```typescript
resolution: z.enum(['low', 'medium']).optional().describe('Response density: low (scanning) or medium (default, full card)'),
```

- [ ] **Step 2: Implement low-resolution response**

After the SQL query and row mapping, if `resolution === 'low'`, strip the sessions to the minimal shape:

```typescript
const resolution = params.resolution ?? 'medium'

let sessions = rows.map(row => ({ /* current full mapping */ }))

if (resolution === 'low') {
  sessions = sessions.map(s => ({
    id: s.id,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    durationMinutes: s.durationMinutes,
    topic: s.topic,
  })) as typeof sessions
}
```

The SQL query stays the same (all columns) — low resolution just strips the response shape. Simpler than maintaining two query paths.

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add src/tools/list-sessions.ts
git commit -m "feat: add resolution param to list_sessions (low/medium)"
```

---

### Task 6: Add focus and intent to get_session

**Files:**
- Modify: `src/tools/get-session.ts`

- [ ] **Step 1: Add focus and intent parameters**

Add to the Zod schema:

```typescript
focus: z.enum(['general', 'tools', 'errors', 'files', 'decisions']).optional().describe('Distillation lens for conversation sample (detail=full only)'),
intent: z.string().max(500).optional().describe('Free-text analysis intent — triggers live LLM analysis (detail=full only)'),
```

- [ ] **Step 2: Pass focus to distillConversation**

Change the `detail === 'full'` block (line 113-121):

```typescript
if (detail === 'full') {
  const registry = container.resolve<AdapterRegistry>(TOKENS.AdapterRegistry)
  const messages: NormalizedMessage[] = []
  for await (const msg of registry.getMessages(params.sessionId)) {
    messages.push(msg)
  }
  const focus = params.focus ?? 'general'
  const distilled = distillConversation(messages, { n: 10, focus })
  result.conversationSample = distilled.messages

  // Intent-based LLM analysis
  if (params.intent && messages.length >= 3) {
    try {
      const llmClient = container.resolve<LocalLlmClient>(TOKENS.LocalLlmClient)
      const available = await llmClient.isAvailable()
      if (available) {
        const metricsBlock = [
          `Duration: ${session.duration_minutes ?? 0} min, ${session.total_turns ?? 0} turns`,
          `Errors: ${session.error_count ?? 0}, Corrections: ${session.correction_count ?? 0}`,
          session.tool_counts ? `Tools: ${formatTopTools(session.tool_counts)}` : null,
          session.files_changed ? `Files: ${formatFiles(session.files_changed)}` : null,
        ].filter(Boolean).join('\n')

        const conversationBlock = distilled.messages
          .map(m => m.role === 'action' ? m.text : `${m.role}: ${m.text}`)
          .join('\n')

        const prompt = `You are analyzing a coding session for a specific purpose.\n\nCaller's intent: ${params.intent}\nFocus area: ${focus}\n\nSession metrics:\n${metricsBlock}\n\nConversation (${focus}-focused):\n${conversationBlock}\n\nAnswer:\n1. Is this session relevant to the caller's intent? (yes/no)\n2. If relevant, explain specifically how — cite concrete details.\n3. If not relevant, say what the session was actually about in one sentence.\n\nBe concise.`

        const llmResponse = await llmClient.summarize(prompt, 300)
        const relevant = !llmResponse.toLowerCase().startsWith('no')
        result.analysis = {
          relevant,
          summary: llmResponse,
          generatedAt: new Date().toISOString(),
        }
      }
    } catch {
      result.analysis = null
    }
  } else if (params.intent && messages.length < 3) {
    result.analysis = { relevant: false, summary: 'Too few messages for analysis', reason: 'too_few_messages' }
  }
}
```

Add helper functions (module-level):

```typescript
function formatTopTools(json: string): string {
  try {
    const counts = JSON.parse(json) as Record<string, number>
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, c]) => `${n}(${c})`).join(', ')
  } catch { return '' }
}

function formatFiles(json: string): string {
  try {
    const files = JSON.parse(json) as Array<{ path: string; op: string }>
    return files.slice(0, 5).map(f => `${f.path} (${f.op})`).join(', ')
  } catch { return '' }
}
```

Add import for `LocalLlmClient`:

```typescript
import type { LocalLlmClient } from '../services/local-llm-client'
```

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add src/tools/get-session.ts
git commit -m "feat: add focus and intent params to get_session for targeted analysis"
```

---

### Task 7: Add focus to get_conversation

**Files:**
- Modify: `src/tools/get-conversation.ts`

- [ ] **Step 1: Add focus parameter**

Add to Zod schema:

```typescript
focus: z.enum(['general', 'tools', 'errors', 'files', 'decisions']).optional().describe('Distillation lens — adds a distilled view alongside raw messages (ignored when includeToolResults=true)'),
```

- [ ] **Step 2: Add distilled field to response**

After the existing message processing pipeline, if focus is set and `includeToolResults` is not true:

```typescript
import { distillConversation } from '../services/conversation-distiller'

// After pagination, before building response:
let distilled = undefined
if (params.focus && !params.includeToolResults) {
  const distillResult = distillConversation(page.items, { focus: params.focus })
  distilled = distillResult.messages
}

const data = {
  sessionId: params.sessionId,
  messages: page.items,
  distilled,  // undefined if no focus — omitted from JSON
  totalMessages,
  truncated,
}
```

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add src/tools/get-conversation.ts
git commit -m "feat: add focus param to get_conversation with distilled view"
```

---

### Task 8: Run full test suite and validate with real data

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 2: Delete DB and restart MCP**

```bash
rm -f ~/.claude/session-mcp-index.db
```

Then restart MCP server (`/mcp`).

- [ ] **Step 3: Test list_sessions with resolution=low**

Call `list_sessions` with `resolution=low` — verify minimal response shape.

- [ ] **Step 4: Test get_session with focus=tools**

Call `get_session` with `detail=full` and `focus=tools` on a KiCad session — verify tool params in conversation sample.

- [ ] **Step 5: Test get_session with focus=errors**

Call `get_session` with `detail=full` and `focus=errors` — verify error windowing with gap markers.

- [ ] **Step 6: Test get_session with intent**

Call `get_session` with `detail=full`, `focus=tools`, `intent="find sessions where footprints were changed"` — verify analysis field (if LLM available).

- [ ] **Step 7: Test get_conversation with focus**

Call `get_conversation` with `focus=decisions` — verify distilled field present with only user/assistant text.

- [ ] **Step 8: Final commit**

```bash
git add -A
git commit -m "feat: complete adaptive resolution — focus modes and intent analysis"
```
