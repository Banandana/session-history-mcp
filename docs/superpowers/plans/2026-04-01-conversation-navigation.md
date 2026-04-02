# Conversation Navigation Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace monolithic `get_conversation` with a three-tool navigation flow: overview (phase-clustered), query (structured search), and expand (full detail).

**Architecture:** New `turn_events` DB table for cross-session structured queries, populated during sync. Phase clusterer groups turns by activity category. Existing `get_conversation` stripped to overview-only; two new tools (`query_turns`, `get_turns`) handle search and expansion. Conversation distiller and focus/window logic removed.

**Tech Stack:** TypeScript (strict ESM), better-sqlite3, vitest, tsyringe DI, `@modelcontextprotocol/sdk`

**Spec:** `docs/superpowers/specs/2026-04-01-conversation-navigation-design.md`

---

### Task 1: DB Migration — `turn_events` table + `turn_events_indexed` column

**Files:**
- Modify: `src/services/index-manager.ts:109-115` (add migrateToV2)

- [ ] **Step 1: Write failing test for V2 migration**

Create test in `src/services/index-manager.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { IndexManager } from './index-manager'

describe('IndexManager', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
  })

  afterEach(() => {
    db.close()
  })

  describe('migrateToV2', () => {
    it('creates turn_events table with correct schema', () => {
      const manager = new IndexManager(db)
      manager.ensureSchema()

      const columns = db.prepare("PRAGMA table_info('turn_events')").all() as Array<{ name: string; type: string; notnull: number }>
      const colNames = columns.map(c => c.name)

      expect(colNames).toContain('session_id')
      expect(colNames).toContain('turn_index')
      expect(colNames).toContain('turn_id')
      expect(colNames).toContain('role')
      expect(colNames).toContain('timestamp')
      expect(colNames).toContain('tool_names')
      expect(colNames).toContain('is_error')
      expect(colNames).toContain('is_correction')
      expect(colNames).toContain('text_preview')
    })

    it('adds turn_events_indexed column to sessions', () => {
      const manager = new IndexManager(db)
      manager.ensureSchema()

      const columns = db.prepare("PRAGMA table_info('sessions')").all() as Array<{ name: string }>
      expect(columns.some(c => c.name === 'turn_events_indexed')).toBe(true)
    })

    it('sets user_version to 2', () => {
      const manager = new IndexManager(db)
      manager.ensureSchema()

      const version = db.pragma('user_version', { simple: true }) as number
      expect(version).toBe(2)
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/index-manager.test.ts`
Expected: FAIL — `turn_events` table doesn't exist

- [ ] **Step 3: Implement V2 migration**

In `src/services/index-manager.ts`, add to `runMigrations()`:

```typescript
private runMigrations(): void {
  const userVersion = this.db.pragma('user_version', { simple: true }) as number

  if (userVersion < 1) {
    this.migrateToV1()
  }
  if (userVersion < 2) {
    this.migrateToV2()
  }
}

private migrateToV2(): void {
  this.db.exec(`
    CREATE TABLE IF NOT EXISTS turn_events (
      session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      turn_index    INTEGER NOT NULL,
      turn_id       TEXT NOT NULL,
      role          TEXT NOT NULL,
      timestamp     TEXT NOT NULL,
      tool_names    TEXT NOT NULL DEFAULT '[]',
      is_error      INTEGER NOT NULL DEFAULT 0,
      is_correction INTEGER NOT NULL DEFAULT 0,
      text_preview  TEXT,
      PRIMARY KEY (session_id, turn_index)
    );

    CREATE INDEX IF NOT EXISTS idx_turn_events_error ON turn_events(is_error) WHERE is_error = 1;
    CREATE INDEX IF NOT EXISTS idx_turn_events_correction ON turn_events(is_correction) WHERE is_correction = 1;
    CREATE INDEX IF NOT EXISTS idx_turn_events_timestamp ON turn_events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_turn_events_session_id ON turn_events(session_id);
  `)

  this.addColumnIfMissing('sessions', 'turn_events_indexed', 'INTEGER DEFAULT 0')

  this.db.pragma('user_version = 2')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/services/index-manager.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/index-manager.ts src/services/index-manager.test.ts
git commit -m "feat: add turn_events table and V2 migration"
```

---

### Task 2: TurnIndexer service — populate `turn_events` during sync

**Files:**
- Create: `src/services/turn-indexer.ts`
- Create: `src/services/turn-indexer.test.ts`

- [ ] **Step 1: Write failing test for TurnIndexer**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { TurnIndexer } from './turn-indexer'
import type { NormalizedMessage } from '../types'

function makeMessage(overrides: Partial<NormalizedMessage> & { id: string }): NormalizedMessage {
  return {
    id: overrides.id,
    sessionId: 'session-1',
    role: overrides.role ?? 'assistant',
    timestamp: overrides.timestamp ?? '2026-01-01T00:00:00Z',
    contentBlocks: overrides.contentBlocks ?? [{ type: 'text', text: 'hello' }],
    isError: overrides.isError ?? false,
    isCorrection: overrides.isCorrection ?? false,
    uuid: overrides.id,
    toolNames: overrides.toolNames,
  }
}

describe('TurnIndexer', () => {
  let db: Database.Database
  let indexer: TurnIndexer

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    // Create minimal schema
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, turn_events_indexed INTEGER DEFAULT 0);
      CREATE TABLE turn_events (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        turn_index INTEGER NOT NULL,
        turn_id TEXT NOT NULL,
        role TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        tool_names TEXT NOT NULL DEFAULT '[]',
        is_error INTEGER NOT NULL DEFAULT 0,
        is_correction INTEGER NOT NULL DEFAULT 0,
        text_preview TEXT,
        PRIMARY KEY (session_id, turn_index)
      );
    `)
    db.prepare("INSERT INTO sessions (id, source) VALUES ('session-1', 'claude-code')").run()
    indexer = new TurnIndexer(db)
  })

  afterEach(() => db.close())

  it('indexes messages as turn events', () => {
    const messages: NormalizedMessage[] = [
      makeMessage({ id: 'msg-1', role: 'user', contentBlocks: [{ type: 'text', text: 'fix the bug' }] }),
      makeMessage({
        id: 'msg-2',
        role: 'assistant',
        toolNames: ['Bash', 'Edit'],
        contentBlocks: [
          { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
          { type: 'tool_use', name: 'Edit', input: { file_path: '/src/app.ts' } },
        ],
      }),
    ]

    indexer.indexSession('session-1', messages)

    const rows = db.prepare('SELECT * FROM turn_events WHERE session_id = ? ORDER BY turn_index').all('session-1') as any[]
    expect(rows).toHaveLength(2)
    expect(rows[0].turn_index).toBe(0)
    expect(rows[0].role).toBe('user')
    expect(rows[0].text_preview).toBe('fix the bug')
    expect(JSON.parse(rows[0].tool_names)).toEqual([])
    expect(rows[1].turn_index).toBe(1)
    expect(JSON.parse(rows[1].tool_names)).toEqual(['Bash', 'Edit'])
  })

  it('marks session as indexed', () => {
    indexer.indexSession('session-1', [])

    const row = db.prepare('SELECT turn_events_indexed FROM sessions WHERE id = ?').get('session-1') as any
    expect(row.turn_events_indexed).toBe(1)
  })

  it('replaces existing turn events on re-index', () => {
    const messages = [makeMessage({ id: 'msg-1', role: 'user' })]
    indexer.indexSession('session-1', messages)
    indexer.indexSession('session-1', messages)

    const count = db.prepare('SELECT COUNT(*) as c FROM turn_events WHERE session_id = ?').get('session-1') as any
    expect(count.c).toBe(1)
  })

  it('stores error and correction flags', () => {
    const messages = [
      makeMessage({ id: 'msg-1', isError: true, isCorrection: false }),
      makeMessage({ id: 'msg-2', isError: false, isCorrection: true }),
    ]

    indexer.indexSession('session-1', messages)

    const rows = db.prepare('SELECT is_error, is_correction FROM turn_events WHERE session_id = ? ORDER BY turn_index').all('session-1') as any[]
    expect(rows[0].is_error).toBe(1)
    expect(rows[0].is_correction).toBe(0)
    expect(rows[1].is_error).toBe(0)
    expect(rows[1].is_correction).toBe(1)
  })

  it('truncates text_preview to 200 chars', () => {
    const longText = 'a'.repeat(400)
    const messages = [
      makeMessage({ id: 'msg-1', contentBlocks: [{ type: 'text', text: longText }] }),
    ]

    indexer.indexSession('session-1', messages)

    const row = db.prepare('SELECT text_preview FROM turn_events WHERE session_id = ?').get('session-1') as any
    expect(row.text_preview.length).toBe(200)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/turn-indexer.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement TurnIndexer**

```typescript
import type Database from 'better-sqlite3'
import type { NormalizedMessage } from '../types'

const MAX_PREVIEW_LENGTH = 200

export class TurnIndexer {
  constructor(private readonly db: Database.Database) {}

  indexSession(sessionId: string, messages: readonly NormalizedMessage[]): void {
    this.db.prepare('DELETE FROM turn_events WHERE session_id = ?').run(sessionId)

    const insert = this.db.prepare(`
      INSERT INTO turn_events (session_id, turn_index, turn_id, role, timestamp, tool_names, is_error, is_correction, text_preview)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    const insertMany = this.db.transaction((msgs: readonly NormalizedMessage[]) => {
      for (let i = 0; i < msgs.length; i++) {
        const msg = msgs[i]
        const toolNames = msg.toolNames && msg.toolNames.length > 0
          ? JSON.stringify([...msg.toolNames])
          : '[]'
        const textPreview = this.extractPreview(msg)

        insert.run(
          sessionId,
          i,
          msg.uuid,
          msg.role,
          msg.timestamp,
          toolNames,
          msg.isError ? 1 : 0,
          msg.isCorrection ? 1 : 0,
          textPreview,
        )
      }
    })

    insertMany(messages)

    this.db.prepare('UPDATE sessions SET turn_events_indexed = 1 WHERE id = ?').run(sessionId)
  }

  private extractPreview(msg: NormalizedMessage): string | null {
    for (const block of msg.contentBlocks) {
      if (block.type === 'text' && block.text) {
        return block.text.length > MAX_PREVIEW_LENGTH
          ? block.text.slice(0, MAX_PREVIEW_LENGTH)
          : block.text
      }
    }
    return null
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/services/turn-indexer.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/turn-indexer.ts src/services/turn-indexer.test.ts
git commit -m "feat: add TurnIndexer service for turn_events population"
```

---

### Task 3: Integrate TurnIndexer into sync pipeline

**Files:**
- Modify: `src/services/freshness-guard.ts:268-367` (syncChangedSessions method)
- Modify: `src/container/tokens.ts` (add TurnIndexer token)
- Modify: `src/container/modules.ts` (register TurnIndexer)

- [ ] **Step 1: Add DI token**

In `src/container/tokens.ts`, add:

```typescript
TurnIndexer: Symbol('TurnIndexer'),
```

- [ ] **Step 2: Register TurnIndexer in modules.ts**

In `src/container/modules.ts`, add import and registration:

```typescript
import { TurnIndexer } from '../services/turn-indexer'
```

After the `indexManager` registration (around line 39), add:

```typescript
const turnIndexer = new TurnIndexer(db)
container.register(TOKENS.TurnIndexer, { useValue: turnIndexer })
```

- [ ] **Step 3: Add TurnIndexer call in FreshnessGuard.syncChangedSessions**

In `src/services/freshness-guard.ts`, add a `TurnIndexer` field and call it after message sync. The messages are already collected in the `messages` array (line 281-284). After the `computeSessionMetrics` call (line 363), add:

```typescript
// Index turn events for structured queries
this.turnIndexer.indexSession(sessionId, messages)
```

The `TurnIndexer` should be passed as a constructor parameter. Update the constructor signature and the `modules.ts` instantiation to pass it.

- [ ] **Step 4: Run all tests**

Run: `npx vitest run`
Expected: PASS (existing tests should not break)

- [ ] **Step 5: Commit**

```bash
git add src/container/tokens.ts src/container/modules.ts src/services/freshness-guard.ts
git commit -m "feat: integrate TurnIndexer into sync pipeline"
```

---

### Task 4: PhaseClusterer service

**Files:**
- Create: `src/services/phase-clusterer.ts`
- Create: `src/services/phase-clusterer.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, it, expect } from 'vitest'
import { PhaseClusterer } from './phase-clusterer'
import type { NormalizedMessage } from '../types'

function makeMessage(overrides: Partial<NormalizedMessage> & { id: string }): NormalizedMessage {
  return {
    id: overrides.id,
    sessionId: 'session-1',
    role: overrides.role ?? 'assistant',
    timestamp: overrides.timestamp ?? '2026-01-01T00:00:00Z',
    contentBlocks: overrides.contentBlocks ?? [{ type: 'text', text: 'hello' }],
    isError: overrides.isError ?? false,
    isCorrection: overrides.isCorrection ?? false,
    uuid: overrides.id,
    toolNames: overrides.toolNames,
  }
}

describe('PhaseClusterer', () => {
  const clusterer = new PhaseClusterer()

  it('returns one phase per turn for sessions under 10 turns', () => {
    const messages = [
      makeMessage({ id: '1', role: 'user' }),
      makeMessage({ id: '2', role: 'assistant', toolNames: ['Read'] }),
    ]

    const phases = clusterer.cluster(messages)

    expect(phases).toHaveLength(2)
    expect(phases[0].turnRange).toEqual({ from: 0, to: 0 })
    expect(phases[1].turnRange).toEqual({ from: 1, to: 1 })
  })

  it('groups consecutive turns of same category', () => {
    const messages = Array.from({ length: 15 }, (_, i) =>
      makeMessage({
        id: `msg-${i}`,
        role: 'assistant',
        toolNames: i < 5 ? ['Read', 'Grep'] : i < 10 ? ['Edit', 'Write'] : ['Bash'],
        contentBlocks: [{ type: 'tool_use', name: i < 5 ? 'Read' : i < 10 ? 'Edit' : 'Bash' }],
      })
    )

    const phases = clusterer.cluster(messages)

    expect(phases.length).toBeGreaterThanOrEqual(3)
    expect(phases[0].description).toContain('Explore')
    expect(phases[1].description).toContain('Modify')
    expect(phases[2].description).toContain('Execute')
  })

  it('error turns take priority over tool category', () => {
    const messages = Array.from({ length: 12 }, (_, i) =>
      makeMessage({
        id: `msg-${i}`,
        role: 'assistant',
        toolNames: ['Bash'],
        isError: i >= 5 && i <= 7,
        contentBlocks: [{ type: 'tool_use', name: 'Bash' }],
      })
    )

    const phases = clusterer.cluster(messages)
    const errorPhase = phases.find(p => p.description.includes('Error'))

    expect(errorPhase).toBeDefined()
    expect(errorPhase!.errorCount).toBeGreaterThan(0)
  })

  it('absorbs single-turn phases surrounded by same category', () => {
    // 5 Explore, 1 Modify, 5 Explore — the lone Modify should be absorbed
    const messages = Array.from({ length: 12 }, (_, i) =>
      makeMessage({
        id: `msg-${i}`,
        role: 'assistant',
        toolNames: i === 5 ? ['Edit'] : ['Read'],
        contentBlocks: [{ type: 'tool_use', name: i === 5 ? 'Edit' : 'Read' }],
      })
    )

    const phases = clusterer.cluster(messages)
    // The lone Edit turn should be absorbed into surrounding Explore phase
    const modifyPhases = phases.filter(p => p.description.includes('Modify'))
    expect(modifyPhases).toHaveLength(0)

    // Should produce a single Explore phase covering all 12 turns
    expect(phases).toHaveLength(1)
    expect(phases[0].turnRange).toEqual({ from: 0, to: 11 })
    expect(phases[0].turnCount).toBe(12)
    expect(phases[0].toolNames).toContain('Read')
    expect(phases[0].toolNames).toContain('Edit')
  })

  it('includes tool names and error counts per phase', () => {
    const messages = Array.from({ length: 12 }, (_, i) =>
      makeMessage({
        id: `msg-${i}`,
        role: 'assistant',
        toolNames: ['Read', 'Grep'],
        isError: i === 3,
        contentBlocks: [{ type: 'tool_use', name: 'Read' }],
      })
    )

    const phases = clusterer.cluster(messages)

    // At least one phase should list Read and Grep
    const hasToolInfo = phases.some(p => p.toolNames.includes('Read'))
    expect(hasToolInfo).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/phase-clusterer.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement PhaseClusterer**

```typescript
import type { NormalizedMessage } from '../types'

export interface Phase {
  readonly turnRange: { readonly from: number; readonly to: number }
  readonly description: string
  readonly toolNames: readonly string[]
  readonly errorCount: number
  readonly turnCount: number
}

type Category = 'Error' | 'Modify' | 'Execute' | 'Explore' | 'Discuss'

const EXPLORE_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS'])
const MODIFY_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])
const EXECUTE_TOOLS = new Set(['Bash'])

function isExploreAgent(tools: readonly string[], blocks: readonly import('../types').ContentBlock[]): boolean {
  if (!tools.includes('Agent')) return false
  // Check if any Agent tool_use block has Explore subagent_type in its input
  for (const block of blocks) {
    if (block.type === 'tool_use' && block.name === 'Agent') {
      const input = block.input as Record<string, unknown> | undefined
      if (input?.subagent_type === 'Explore') return true
    }
  }
  return false
}

export class PhaseClusterer {
  cluster(messages: readonly NormalizedMessage[]): readonly Phase[] {
    if (messages.length < 10) {
      return messages.map((msg, i) => this.singleTurnPhase(msg, i))
    }

    const categories = messages.map(msg => this.categorize(msg))
    let phases = this.groupConsecutive(messages, categories)
    phases = this.absorbSingletons(phases, categories)

    return phases
  }

  private categorize(msg: NormalizedMessage): Category {
    if (msg.isError) return 'Error'

    const tools = msg.toolNames ?? []
    if (tools.length === 0) return 'Discuss'

    // Highest priority category present
    if (tools.some(t => MODIFY_TOOLS.has(t))) return 'Modify'
    if (tools.some(t => EXECUTE_TOOLS.has(t))) return 'Execute'
    if (tools.some(t => EXPLORE_TOOLS.has(t))) return 'Explore'
    if (isExploreAgent(tools, msg.contentBlocks)) return 'Explore'

    // Agent calls or unknown tools default to Execute
    return 'Execute'
  }

  private singleTurnPhase(msg: NormalizedMessage, index: number): Phase {
    const category = this.categorize(msg)
    const tools = [...new Set(msg.toolNames ?? [])]

    return {
      turnRange: { from: index, to: index },
      description: this.describeCategory(category, tools),
      toolNames: tools,
      errorCount: msg.isError ? 1 : 0,
      turnCount: 1,
    }
  }

  private groupConsecutive(
    messages: readonly NormalizedMessage[],
    categories: readonly Category[],
  ): Phase[] {
    const phases: Phase[] = []
    let phaseStart = 0

    for (let i = 1; i <= messages.length; i++) {
      if (i === messages.length || categories[i] !== categories[phaseStart]) {
        const slice = messages.slice(phaseStart, i)
        const allTools = new Set<string>()
        let errors = 0

        for (const msg of slice) {
          for (const t of msg.toolNames ?? []) allTools.add(t)
          if (msg.isError) errors++
        }

        const tools = [...allTools]

        phases.push({
          turnRange: { from: phaseStart, to: i - 1 },
          description: this.describeCategory(categories[phaseStart], tools),
          toolNames: tools,
          errorCount: errors,
          turnCount: slice.length,
        })

        phaseStart = i
      }
    }

    return phases
  }

  private absorbSingletons(phases: Phase[], categories: readonly Category[]): Phase[] {
    if (phases.length < 3) return phases

    const result: Phase[] = []

    for (let i = 0; i < phases.length; i++) {
      const phase = phases[i]
      const prev = i > 0 ? phases[i - 1] : null
      const next = i < phases.length - 1 ? phases[i + 1] : null

      // Absorb single-turn phases surrounded by same category
      if (
        phase.turnCount === 1 &&
        prev && next &&
        categories[prev.turnRange.from] === categories[next.turnRange.from]
      ) {
        // Merge into previous phase
        const merged = result[result.length - 1]
        const mergedTools = new Set([...merged.toolNames, ...phase.toolNames])
        result[result.length - 1] = {
          turnRange: { from: merged.turnRange.from, to: phase.turnRange.to },
          description: merged.description,
          toolNames: [...mergedTools],
          errorCount: merged.errorCount + phase.errorCount,
          turnCount: merged.turnCount + phase.turnCount,
        }
        continue
      }

      // Try to merge with previous if same category (after absorption changed things)
      if (
        result.length > 0 &&
        categories[result[result.length - 1].turnRange.from] === categories[phase.turnRange.from]
      ) {
        const prev = result[result.length - 1]
        const mergedTools = new Set([...prev.toolNames, ...phase.toolNames])
        result[result.length - 1] = {
          turnRange: { from: prev.turnRange.from, to: phase.turnRange.to },
          description: prev.description,
          toolNames: [...mergedTools],
          errorCount: prev.errorCount + phase.errorCount,
          turnCount: prev.turnCount + phase.turnCount,
        }
        continue
      }

      result.push(phase)
    }

    return result
  }

  private describeCategory(category: Category, tools: readonly string[]): string {
    const toolList = tools.length > 0 ? ` (${tools.slice(0, 4).join(', ')})` : ''

    switch (category) {
      case 'Error': return `Errors${toolList}`
      case 'Modify': return `Modified files${toolList}`
      case 'Execute': return `Executed commands${toolList}`
      case 'Explore': return `Explored codebase${toolList}`
      case 'Discuss': return 'Discussion'
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/services/phase-clusterer.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/phase-clusterer.ts src/services/phase-clusterer.test.ts
git commit -m "feat: add PhaseClusterer service for session overview"
```

---

### Task 5: Rewrite `get_conversation` as overview-only

**Files:**
- Modify: `src/tools/get-conversation.ts` (full rewrite)
- Modify: `src/container/tokens.ts` (add PhaseClusterer token)
- Modify: `src/container/modules.ts` (register PhaseClusterer)

- [ ] **Step 1: Add PhaseClusterer to DI**

In `src/container/tokens.ts`, add:

```typescript
PhaseClusterer: Symbol('PhaseClusterer'),
```

In `src/container/modules.ts`, add import and registration:

```typescript
import { PhaseClusterer } from '../services/phase-clusterer'
```

After TurnIndexer registration, add:

```typescript
const phaseClusterer = new PhaseClusterer()
container.register(TOKENS.PhaseClusterer, { useValue: phaseClusterer })
```

- [ ] **Step 2: Rewrite get-conversation.ts**

Replace the entire file:

```typescript
import { container } from 'tsyringe'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { join } from 'node:path'
import { TOKENS } from '../container/tokens'
import type { FreshnessGuard } from '../services/freshness-guard'
import type { ResponseFormatter } from '../services/response-formatter'
import type { DatabaseConnection } from '../infrastructure/database'
import type { NormalizedMessage } from '../types'
import { ConversationParser } from '../adapters/claude-code/conversation-parser'
import { PhaseClusterer } from '../services/phase-clusterer'

export function registerGetConversation(server: McpServer): void {
  server.tool(
    'get_conversation',
    'Get a phase-clustered overview of a session. Returns session metadata and activity phases with turn ranges. Use query_turns to search within sessions and get_turns to expand specific turns.',
    {
      sessionId: z.string().describe('Session ID'),
      maxTokens: z.number().optional().describe('Token budget for response'),
    },
    async (params) => {
      const freshnessGuard = container.resolve<FreshnessGuard>(TOKENS.FreshnessGuard)
      const formatter = container.resolve<ResponseFormatter>(TOKENS.ResponseFormatter)
      const dbConn = container.resolve<DatabaseConnection>(TOKENS.Database)
      const phaseClusterer = container.resolve<PhaseClusterer>(TOKENS.PhaseClusterer)
      const db = dbConn.get()
      const claudeDir = container.resolve<string>(TOKENS.ClaudeDataDir)

      const freshness = await freshnessGuard.ensureFresh()

      // Get session metadata from DB
      const session = db.prepare(`
        SELECT id, project_slug, cwd, branch, started_at, ended_at, duration_minutes,
               model, total_tokens, total_turns, error_count, correction_count,
               tool_counts, files_changed, topic, summary
        FROM sessions WHERE id = ?
      `).get(params.sessionId) as Record<string, unknown> | undefined

      if (!session) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Session not found: ${params.sessionId}` }, null, 2) }],
        }
      }

      // Parse messages for phase clustering
      const projectSlug = (session.project_slug as string) ?? 'unknown'
      const sessionPath = join(claudeDir, 'projects', projectSlug, `${params.sessionId}.jsonl`)
      const parser = new ConversationParser()
      const messages: NormalizedMessage[] = []

      try {
        for await (const msg of parser.parseSession(sessionPath)) {
          messages.push(msg)
        }
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Failed to read session: ${(err as Error).message}` }, null, 2) }],
        }
      }

      let phases = [...phaseClusterer.cluster(messages)]

      // Parse stored JSON fields
      let toolCounts = session.tool_counts ? JSON.parse(session.tool_counts as string) : {}
      let filesChanged: string[] = session.files_changed ? JSON.parse(session.files_changed as string) : []

      // Apply token budget if set — truncate in order: filesChanged, toolBreakdown, merge phases
      if (params.maxTokens) {
        const estimateTokens = (obj: unknown) => Math.ceil(JSON.stringify(obj).length / 4)

        if (filesChanged.length > 10) {
          filesChanged = filesChanged.slice(0, 10)
        }

        if (Object.keys(toolCounts).length > 10) {
          const sorted = Object.entries(toolCounts).sort((a, b) => (b[1] as number) - (a[1] as number))
          toolCounts = Object.fromEntries(sorted.slice(0, 10))
        }

        // Merge smallest adjacent phases until under budget
        while (phases.length > 2 && estimateTokens({ phases }) > params.maxTokens * 0.7) {
          let smallestIdx = 0
          let smallestCount = Infinity
          for (let i = 0; i < phases.length; i++) {
            if (phases[i].turnCount < smallestCount) {
              smallestCount = phases[i].turnCount
              smallestIdx = i
            }
          }
          // Merge with smaller neighbor
          const mergeIdx = smallestIdx === 0 ? 1
            : smallestIdx === phases.length - 1 ? smallestIdx - 1
            : phases[smallestIdx - 1].turnCount <= phases[smallestIdx + 1].turnCount ? smallestIdx - 1 : smallestIdx + 1
          const [a, b] = mergeIdx < smallestIdx ? [mergeIdx, smallestIdx] : [smallestIdx, mergeIdx]
          const mergedTools = new Set([...phases[a].toolNames, ...phases[b].toolNames])
          phases[a] = {
            turnRange: { from: phases[a].turnRange.from, to: phases[b].turnRange.to },
            description: phases[a].description,
            toolNames: [...mergedTools],
            errorCount: phases[a].errorCount + phases[b].errorCount,
            turnCount: phases[a].turnCount + phases[b].turnCount,
          }
          phases.splice(b, 1)
        }
      }

      const data = {
        sessionId: params.sessionId,
        metadata: {
          topic: session.topic ?? undefined,
          summary: session.summary ?? undefined,
          startedAt: session.started_at,
          endedAt: session.ended_at ?? undefined,
          durationMinutes: session.duration_minutes ?? undefined,
          model: session.model ?? undefined,
          totalTurns: messages.length,
          totalTokens: session.total_tokens ?? undefined,
          errorCount: session.error_count ?? 0,
          correctionCount: session.correction_count ?? 0,
          toolBreakdown: toolCounts,
          filesChanged,
        },
        phases,
      }

      const meta = formatter.formatMeta(freshness)
      const response = formatter.format(data, meta)

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      }
    }
  )
}
```

- [ ] **Step 3: Run all tests to check nothing breaks**

Run: `npx vitest run`
Expected: PASS (distiller tests will be removed in Task 7)

- [ ] **Step 4: Commit**

```bash
git add src/tools/get-conversation.ts src/container/tokens.ts src/container/modules.ts
git commit -m "feat: rewrite get_conversation as phase-clustered overview"
```

---

### Task 6: `query_turns` tool

**Files:**
- Create: `src/tools/query-turns.ts`
- Modify: `src/tools/index.ts` (register new tool)

- [ ] **Step 1: Write the tool implementation**

```typescript
import { container } from 'tsyringe'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { join } from 'node:path'
import { TOKENS } from '../container/tokens'
import type { FreshnessGuard } from '../services/freshness-guard'
import type { ResponseFormatter } from '../services/response-formatter'
import type { DatabaseConnection } from '../infrastructure/database'
import type { NormalizedMessage } from '../types'
import { ConversationParser } from '../adapters/claude-code/conversation-parser'
import { TurnIndexer } from '../services/turn-indexer'
import { extractToolParams } from '../services/conversation-distiller'

// NOTE: extractToolParams should be extracted from the distiller into a shared
// utility (e.g., src/services/tool-summary.ts) before the distiller is deleted
// in Task 8. Move it during that task.

interface TurnReference {
  readonly sessionId: string
  readonly turnIndex: number
  readonly turnId: string
  readonly timestamp: string
  readonly role: string
  readonly summary: string
  readonly toolNames: readonly string[]
  readonly isError: boolean
  readonly isCorrection: boolean
  readonly matchContext?: string
}

function summarizeMessage(msg: NormalizedMessage): string {
  if (msg.isError) {
    for (const block of msg.contentBlocks) {
      if (block.type === 'tool_result' && typeof block.content === 'string') {
        return `[error: ${block.content.slice(0, 120)}]`
      }
      if (block.type === 'text' && block.text) {
        return `[error: ${block.text.slice(0, 120)}]`
      }
    }
    return '[error]'
  }

  const tools = msg.toolNames ?? []
  if (tools.length > 0) {
    // Find the first tool_use block for param extraction
    const firstToolBlock = msg.contentBlocks.find(b => b.type === 'tool_use')
    if (tools.length === 1 && firstToolBlock) {
      return `[${extractToolParams(tools[0], firstToolBlock.input)}]`
    }
    return `[${tools.join(', ')}]`
  }

  // Text-only turn
  for (const block of msg.contentBlocks) {
    if (block.type === 'text' && block.text) {
      return block.text.slice(0, 120)
    }
  }

  return ''
}

function messageMatchesFilters(
  msg: NormalizedMessage,
  index: number,
  filters: {
    toolNames?: string[]
    isError?: boolean
    isCorrection?: boolean
    roles?: string[]
    textPattern?: string
    turnRange?: { from?: number; to?: number }
  },
): { matches: boolean; matchContext?: string } {
  if (filters.roles && !filters.roles.includes(msg.role)) return { matches: false }
  if (filters.isError !== undefined && msg.isError !== filters.isError) return { matches: false }
  if (filters.isCorrection !== undefined && msg.isCorrection !== filters.isCorrection) return { matches: false }

  if (filters.toolNames && filters.toolNames.length > 0) {
    const msgTools = new Set(msg.toolNames ?? [])
    if (!filters.toolNames.some(t => msgTools.has(t))) return { matches: false }
  }

  if (filters.turnRange) {
    if (filters.turnRange.from !== undefined && index < filters.turnRange.from) return { matches: false }
    if (filters.turnRange.to !== undefined && index > filters.turnRange.to) return { matches: false }
  }

  if (filters.textPattern) {
    const regex = new RegExp(filters.textPattern, 'i')
    for (const block of msg.contentBlocks) {
      const text = block.text ?? (typeof block.content === 'string' ? block.content : '')
      if (text && regex.test(text)) {
        const matchIdx = text.search(regex)
        const start = Math.max(0, matchIdx - 40)
        const end = Math.min(text.length, matchIdx + 80)
        return { matches: true, matchContext: text.slice(start, end) }
      }
    }
    return { matches: false }
  }

  return { matches: true }
}

export function registerQueryTurns(server: McpServer): void {
  server.tool(
    'query_turns',
    'Search for turns matching structured criteria within a session (JSONL) or across sessions (DB). Returns lightweight turn references with summaries. Use get_turns to expand specific results.',
    {
      sessionId: z.string().optional().describe('Scope to one session'),
      projectId: z.string().optional().describe('Scope to a project (cross-session query)'),
      toolNames: z.array(z.string()).optional().describe('Filter turns containing any of these tools'),
      isError: z.boolean().optional().describe('Only error turns'),
      isCorrection: z.boolean().optional().describe('Only correction turns'),
      roles: z.array(z.enum(['user', 'assistant'])).optional().describe('Filter by role'),
      textPattern: z.string().optional().describe('Regex match against turn text (single-session only)'),
      timeRange: z.object({
        after: z.string().optional(),
        before: z.string().optional(),
      }).optional().describe('ISO timestamp range'),
      turnRange: z.object({
        from: z.number().optional(),
        to: z.number().optional(),
      }).optional().describe('Turn index range (single-session only)'),
      limit: z.number().optional().describe('Max results (default 50)'),
      cursor: z.string().optional().describe('Pagination cursor (offset-based)'),
    },
    async (params) => {
      if (!params.sessionId && !params.projectId) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'At least one of sessionId or projectId is required' }, null, 2) }],
        }
      }

      if (!params.sessionId && params.textPattern) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'textPattern requires sessionId (cross-session text search not supported)' }, null, 2) }],
        }
      }

      if (!params.sessionId && params.turnRange) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'turnRange requires sessionId' }, null, 2) }],
        }
      }

      const freshnessGuard = container.resolve<FreshnessGuard>(TOKENS.FreshnessGuard)
      const formatter = container.resolve<ResponseFormatter>(TOKENS.ResponseFormatter)
      const dbConn = container.resolve<DatabaseConnection>(TOKENS.Database)
      const db = dbConn.get()
      const claudeDir = container.resolve<string>(TOKENS.ClaudeDataDir)

      const freshness = await freshnessGuard.ensureFresh()
      const limit = params.limit ?? 50
      const offset = params.cursor ? parseInt(params.cursor, 10) : 0

      let turns: TurnReference[]
      let totalMatches: number

      if (params.sessionId) {
        // Single-session: parse JSONL
        const result = await querySingleSession(
          params.sessionId, db, claudeDir, params, limit, offset,
        )
        turns = result.turns
        totalMatches = result.totalMatches
      } else {
        // Cross-session: ensure turn_events are indexed, then query DB
        await ensureTurnEventsIndexed(params.projectId!, db, claudeDir)
        const result = queryCrossSession(
          params.projectId!, db, params, limit, offset,
        )
        turns = result.turns
        totalMatches = result.totalMatches
      }

      const hasMore = offset + turns.length < totalMatches
      const nextCursor = hasMore ? String(offset + turns.length) : undefined

      const meta = formatter.formatMeta(freshness)
      const data = {
        turns,
        totalMatches,
        pagination: { cursor: nextCursor, hasMore },
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(formatter.format(data, meta), null, 2) }],
      }
    }
  )
}

async function querySingleSession(
  sessionId: string,
  db: ReturnType<DatabaseConnection['get']>,
  claudeDir: string,
  filters: {
    toolNames?: string[]
    isError?: boolean
    isCorrection?: boolean
    roles?: string[]
    textPattern?: string
    turnRange?: { from?: number; to?: number }
    timeRange?: { after?: string; before?: string }
  },
  limit: number,
  offset: number,
): Promise<{ turns: TurnReference[]; totalMatches: number }> {
  const session = db.prepare('SELECT project_slug FROM sessions WHERE id = ?').get(sessionId) as { project_slug: string } | undefined
  if (!session) return { turns: [], totalMatches: 0 }

  const sessionPath = join(claudeDir, 'projects', session.project_slug, `${sessionId}.jsonl`)
  const parser = new ConversationParser()
  const matches: TurnReference[] = []

  let index = 0
  for await (const msg of parser.parseSession(sessionPath)) {
    // Time range filter
    if (filters.timeRange?.after && msg.timestamp < filters.timeRange.after) { index++; continue }
    if (filters.timeRange?.before && msg.timestamp > filters.timeRange.before) { index++; continue }

    const { matches: isMatch, matchContext } = messageMatchesFilters(msg, index, filters)

    if (isMatch) {
      matches.push({
        sessionId,
        turnIndex: index,
        turnId: msg.uuid,
        timestamp: msg.timestamp,
        role: msg.role,
        summary: summarizeMessage(msg),
        toolNames: [...(msg.toolNames ?? [])],
        isError: msg.isError,
        isCorrection: msg.isCorrection,
        matchContext,
      })
    }
    index++
  }

  const totalMatches = matches.length
  const paged = matches.slice(offset, offset + limit)

  return { turns: paged, totalMatches }
}

async function ensureTurnEventsIndexed(
  projectId: string,
  db: ReturnType<DatabaseConnection['get']>,
  claudeDir: string,
): Promise<void> {
  const unindexed = db.prepare(
    'SELECT id, project_slug FROM sessions WHERE project_slug = ? AND turn_events_indexed = 0'
  ).all(projectId) as Array<{ id: string; project_slug: string }>

  if (unindexed.length === 0) return

  const turnIndexer = container.resolve<TurnIndexer>(TOKENS.TurnIndexer)
  const parser = new ConversationParser()

  for (const session of unindexed) {
    const sessionPath = join(claudeDir, 'projects', session.project_slug, `${session.id}.jsonl`)
    const messages: NormalizedMessage[] = []
    try {
      for await (const msg of parser.parseSession(sessionPath)) {
        messages.push(msg)
      }
      turnIndexer.indexSession(session.id, messages)
    } catch {
      // Skip sessions with missing/corrupt JSONL
    }
  }
}

function queryCrossSession(
  projectId: string,
  db: ReturnType<DatabaseConnection['get']>,
  filters: {
    toolNames?: string[]
    isError?: boolean
    isCorrection?: boolean
    roles?: string[]
    timeRange?: { after?: string; before?: string }
  },
  limit: number,
  offset: number,
): { turns: TurnReference[]; totalMatches: number } {
  const conditions: string[] = ['s.project_slug = ?']
  const params: unknown[] = [projectId]

  if (filters.isError !== undefined) {
    conditions.push('te.is_error = ?')
    params.push(filters.isError ? 1 : 0)
  }

  if (filters.isCorrection !== undefined) {
    conditions.push('te.is_correction = ?')
    params.push(filters.isCorrection ? 1 : 0)
  }

  if (filters.roles && filters.roles.length > 0) {
    conditions.push(`te.role IN (${filters.roles.map(() => '?').join(',')})`)
    params.push(...filters.roles)
  }

  if (filters.timeRange?.after) {
    conditions.push('te.timestamp >= ?')
    params.push(filters.timeRange.after)
  }

  if (filters.timeRange?.before) {
    conditions.push('te.timestamp <= ?')
    params.push(filters.timeRange.before)
  }

  let toolJoin = ''
  if (filters.toolNames && filters.toolNames.length > 0) {
    toolJoin = ', json_each(te.tool_names) AS tn'
    conditions.push(`tn.value IN (${filters.toolNames.map(() => '?').join(',')})`)
    params.push(...filters.toolNames)
  }

  const where = conditions.join(' AND ')

  // Count total
  const countSql = `SELECT COUNT(DISTINCT te.session_id || '-' || te.turn_index) as total FROM turn_events te JOIN sessions s ON te.session_id = s.id ${toolJoin} WHERE ${where}`
  const countRow = db.prepare(countSql).get(...params) as { total: number }
  const totalMatches = countRow.total

  // Fetch page
  const selectSql = `
    SELECT DISTINCT te.session_id, te.turn_index, te.turn_id, te.role, te.timestamp,
           te.tool_names, te.is_error, te.is_correction, te.text_preview
    FROM turn_events te
    JOIN sessions s ON te.session_id = s.id
    ${toolJoin}
    WHERE ${where}
    ORDER BY te.timestamp DESC
    LIMIT ? OFFSET ?
  `
  const rows = db.prepare(selectSql).all(...params, limit, offset) as Array<Record<string, unknown>>

  const turns: TurnReference[] = rows.map(row => {
    const toolNames: string[] = JSON.parse(row.tool_names as string)
    const textPreview = (row.text_preview as string)?.slice(0, 120) ?? ''
    const isError = (row.is_error as number) === 1

    // Build summary: prefer text preview, fall back to tool names
    let summary = textPreview
    if (!summary && isError) {
      summary = '[error]'
    } else if (!summary && toolNames.length > 0) {
      summary = `[${toolNames.join(', ')}]`
    }

    return {
      sessionId: row.session_id as string,
      turnIndex: row.turn_index as number,
      turnId: row.turn_id as string,
      timestamp: row.timestamp as string,
      role: row.role as string,
      summary,
      toolNames,
      isError,
      isCorrection: (row.is_correction as number) === 1,
    }
  })

  return { turns, totalMatches }
}
```

- [ ] **Step 2: Extract query logic into testable functions**

The pure functions `messageMatchesFilters`, `summarizeMessage` should be exported from the tool file (or a separate service) so they can be unit tested. Create `src/tools/query-turns.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { messageMatchesFilters, summarizeMessage } from './query-turns'
import type { NormalizedMessage } from '../types'

function makeMessage(overrides: Partial<NormalizedMessage> & { id: string }): NormalizedMessage {
  return {
    id: overrides.id, sessionId: 'session-1', role: overrides.role ?? 'assistant',
    timestamp: '2026-01-01T00:00:00Z',
    contentBlocks: overrides.contentBlocks ?? [{ type: 'text', text: 'hello' }],
    isError: overrides.isError ?? false, isCorrection: overrides.isCorrection ?? false,
    uuid: overrides.id, toolNames: overrides.toolNames,
  }
}

describe('messageMatchesFilters', () => {
  it('filters by tool names', () => {
    const msg = makeMessage({ id: '1', toolNames: ['Bash', 'Edit'] })
    expect(messageMatchesFilters(msg, 0, { toolNames: ['Bash'] }).matches).toBe(true)
    expect(messageMatchesFilters(msg, 0, { toolNames: ['Read'] }).matches).toBe(false)
  })

  it('filters by error flag', () => {
    const msg = makeMessage({ id: '1', isError: true })
    expect(messageMatchesFilters(msg, 0, { isError: true }).matches).toBe(true)
    expect(messageMatchesFilters(msg, 0, { isError: false }).matches).toBe(false)
  })

  it('filters by text pattern with match context', () => {
    const msg = makeMessage({ id: '1', contentBlocks: [{ type: 'text', text: 'failed to compile auth module' }] })
    const result = messageMatchesFilters(msg, 0, { textPattern: 'compile' })
    expect(result.matches).toBe(true)
    expect(result.matchContext).toContain('compile')
  })

  it('filters by turn range', () => {
    const msg = makeMessage({ id: '1' })
    expect(messageMatchesFilters(msg, 5, { turnRange: { from: 3, to: 7 } }).matches).toBe(true)
    expect(messageMatchesFilters(msg, 1, { turnRange: { from: 3, to: 7 } }).matches).toBe(false)
  })
})

describe('summarizeMessage', () => {
  it('summarizes text-only turns', () => {
    const msg = makeMessage({ id: '1', contentBlocks: [{ type: 'text', text: 'fix the authentication bug' }] })
    expect(summarizeMessage(msg)).toBe('fix the authentication bug')
  })

  it('summarizes error turns', () => {
    const msg = makeMessage({
      id: '1', isError: true,
      contentBlocks: [{ type: 'tool_result', content: 'command not found: npm' }],
    })
    expect(summarizeMessage(msg)).toContain('[error:')
  })

  it('summarizes multi-tool turns', () => {
    const msg = makeMessage({
      id: '1', toolNames: ['Read', 'Grep'],
      contentBlocks: [{ type: 'tool_use', name: 'Read' }, { type: 'tool_use', name: 'Grep' }],
    })
    expect(summarizeMessage(msg)).toBe('[Read, Grep]')
  })
})
```

- [ ] **Step 3: Register in tools/index.ts**

Add import and call:

```typescript
import { registerQueryTurns } from './query-turns'
```

Add `registerQueryTurns(server)` to the `registerTools` function.

- [ ] **Step 4: Run all tests**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/query-turns.ts src/tools/query-turns.test.ts src/tools/index.ts
git commit -m "feat: add query_turns tool for structured turn search"
```

---

### Task 7: `get_turns` tool

**Files:**
- Create: `src/tools/get-turns.ts`
- Modify: `src/tools/index.ts` (register new tool)

- [ ] **Step 1: Write the tool implementation**

```typescript
import { container } from 'tsyringe'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { join } from 'node:path'
import { TOKENS } from '../container/tokens'
import type { FreshnessGuard } from '../services/freshness-guard'
import type { ResponseFormatter } from '../services/response-formatter'
import type { DatabaseConnection } from '../infrastructure/database'
import type { NormalizedMessage, ContentBlock } from '../types'
import { ConversationParser } from '../adapters/claude-code/conversation-parser'

interface ExpandedTurn {
  readonly turnIndex: number
  readonly turnId: string
  readonly role: string
  readonly timestamp: string
  readonly contentBlocks: readonly ContentBlock[]
  readonly toolNames: readonly string[]
  readonly isError: boolean
  readonly isCorrection: boolean
  readonly tokenUsage?: { readonly input_tokens: number; readonly output_tokens: number }
}

const MAX_TURNS = 50
const CHARS_PER_TOKEN = 4

function estimateBlockTokens(block: ContentBlock): number {
  let chars = 0
  if (block.text) chars += block.text.length
  if (block.input) chars += JSON.stringify(block.input).length
  if (block.content) chars += typeof block.content === 'string' ? block.content.length : JSON.stringify(block.content).length
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

function truncateBlock(block: ContentBlock, field: 'content' | 'input' | 'text', maxChars: number): ContentBlock {
  if (field === 'content' && typeof block.content === 'string' && block.content.length > maxChars) {
    return { ...block, content: block.content.slice(0, maxChars) + '\n[truncated]' }
  }
  if (field === 'input' && block.input) {
    return { ...block, input: { _truncated: true } }
  }
  if (field === 'text' && block.text && block.text.length > maxChars) {
    return { ...block, text: block.text.slice(0, maxChars) + '\n[truncated]' }
  }
  return block
}

function truncateBlocks(blocks: readonly ContentBlock[], maxTokens: number): { blocks: ContentBlock[]; truncated: boolean } {
  let totalTokens = blocks.reduce((sum, b) => sum + estimateBlockTokens(b), 0)
  if (totalTokens <= maxTokens) return { blocks: [...blocks], truncated: false }

  let result = [...blocks]

  // Helper to apply truncation pass on blocks matching a filter
  const truncatePass = (
    filter: (b: ContentBlock) => boolean,
    field: 'content' | 'input' | 'text',
  ): void => {
    // Sort indices by token size descending
    const indices = result
      .map((b, i) => ({ block: b, idx: i }))
      .filter(({ block }) => filter(block))
      .sort((a, b) => estimateBlockTokens(b.block) - estimateBlockTokens(a.block))

    for (const { idx } of indices) {
      if (totalTokens <= maxTokens) break
      const before = estimateBlockTokens(result[idx])
      const maxChars = Math.floor(maxTokens * CHARS_PER_TOKEN * 0.3)
      result[idx] = truncateBlock(result[idx], field, maxChars)
      totalTokens -= before - estimateBlockTokens(result[idx])
    }
  }

  // Pass 1: truncate tool_result content (longest first)
  truncatePass(b => b.type === 'tool_result' && b.content !== undefined, 'content')

  // Pass 2: truncate tool_use input (longest first)
  if (totalTokens > maxTokens) {
    truncatePass(b => b.type === 'tool_use' && b.input !== undefined, 'input')
  }

  // Pass 3: truncate text blocks (longest first)
  if (totalTokens > maxTokens) {
    truncatePass(b => b.type === 'text' && b.text !== undefined, 'text')
  }

  return { blocks: result, truncated: true }
}

function truncateTurns(
  turns: readonly ExpandedTurn[],
  maxTokens: number,
): { turns: ExpandedTurn[]; truncated: boolean } {
  // First try per-turn truncation
  const perTurnBudget = Math.floor(maxTokens / Math.max(turns.length, 1))
  let truncated = false
  let result = turns.map(turn => {
    const blockResult = truncateBlocks(turn.contentBlocks, perTurnBudget)
    if (blockResult.truncated) truncated = true
    return { ...turn, contentBlocks: blockResult.blocks }
  })

  // Pass 4: if still over budget, drop turns from the middle (keep first and last)
  const estimateTotal = () => result.reduce((sum, t) =>
    sum + t.contentBlocks.reduce((s, b) => s + estimateBlockTokens(b), 0), 0)

  while (result.length > 2 && estimateTotal() > maxTokens) {
    const midIdx = Math.floor(result.length / 2)
    result.splice(midIdx, 1)
    truncated = true
  }

  return { turns: result, truncated }
}

export function registerGetTurns(server: McpServer): void {
  server.tool(
    'get_turns',
    'Get full content for specific turns in a session — tool inputs, tool outputs, text. Use after query_turns to expand interesting results.',
    {
      sessionId: z.string().describe('Session ID'),
      turnIds: z.array(z.string()).optional().describe('Specific turn UUIDs (max 50)'),
      turnRange: z.object({
        from: z.number().describe('Start index (inclusive)'),
        to: z.number().describe('End index (inclusive)'),
      }).optional().describe('Turn index range'),
      includeToolResults: z.boolean().optional().describe('Include full tool output (default: true)'),
      maxTokens: z.number().optional().describe('Budget cap — truncates tool results first, then inputs'),
    },
    async (params) => {
      if (!params.turnIds && !params.turnRange) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'One of turnIds or turnRange is required' }, null, 2) }],
        }
      }

      if (params.turnIds && params.turnRange) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'turnIds and turnRange are mutually exclusive' }, null, 2) }],
        }
      }

      if (params.turnIds && params.turnIds.length > MAX_TURNS) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `turnIds limited to ${MAX_TURNS} entries` }, null, 2) }],
        }
      }

      if (params.turnRange) {
        const range = params.turnRange.to - params.turnRange.from + 1
        if (range > MAX_TURNS) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: `turnRange limited to ${MAX_TURNS} turns` }, null, 2) }],
          }
        }
      }

      const freshnessGuard = container.resolve<FreshnessGuard>(TOKENS.FreshnessGuard)
      const formatter = container.resolve<ResponseFormatter>(TOKENS.ResponseFormatter)
      const dbConn = container.resolve<DatabaseConnection>(TOKENS.Database)
      const db = dbConn.get()
      const claudeDir = container.resolve<string>(TOKENS.ClaudeDataDir)

      const freshness = await freshnessGuard.ensureFresh()

      const session = db.prepare('SELECT project_slug FROM sessions WHERE id = ?').get(params.sessionId) as { project_slug: string } | undefined
      if (!session) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Session not found: ${params.sessionId}` }, null, 2) }],
        }
      }

      const sessionPath = join(claudeDir, 'projects', session.project_slug, `${params.sessionId}.jsonl`)
      const parser = new ConversationParser()

      // Determine which indices to collect
      const wantedIds = params.turnIds ? new Set(params.turnIds) : null
      const rangeFrom = params.turnRange?.from ?? 0
      const rangeTo = params.turnRange?.to ?? Infinity

      const includeToolResults = params.includeToolResults ?? true
      const turns: ExpandedTurn[] = []
      let index = 0

      for await (const msg of parser.parseSession(sessionPath)) {
        const wanted = wantedIds
          ? wantedIds.has(msg.uuid)
          : (index >= rangeFrom && index <= rangeTo)

        if (wanted) {
          // Strip thinking blocks
          let blocks = msg.contentBlocks.filter(b => b.type !== 'thinking')

          // Optionally strip tool results
          if (!includeToolResults) {
            blocks = blocks.map(b =>
              b.type === 'tool_result'
                ? { type: 'tool_result' as const, tool_use_id: b.tool_use_id }
                : b
            )
          }

          turns.push({
            turnIndex: index,
            turnId: msg.uuid,
            role: msg.role,
            timestamp: msg.timestamp,
            contentBlocks: blocks,
            toolNames: [...(msg.toolNames ?? [])],
            isError: msg.isError,
            isCorrection: msg.isCorrection,
            tokenUsage: msg.tokenUsage,
          })
        }

        index++

        // Early exit for range queries past the end
        if (!wantedIds && index > rangeTo) break
      }

      // Apply token budget (4-stage truncation per spec)
      let truncated = false
      let finalTurns: ExpandedTurn[] = [...turns]
      if (params.maxTokens) {
        const budgetResult = truncateTurns(turns, params.maxTokens)
        finalTurns = budgetResult.turns
        truncated = budgetResult.truncated
      }

      const meta = formatter.formatMeta(freshness)
      const data = {
        sessionId: params.sessionId,
        turns: finalTurns,
        truncated,
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(formatter.format(data, meta), null, 2) }],
      }
    }
  )
}
```

- [ ] **Step 2: Write tests for truncation logic**

Create `src/tools/get-turns.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { truncateBlocks, truncateTurns } from './get-turns'
import type { ContentBlock } from '../types'

describe('truncateBlocks', () => {
  it('returns blocks unchanged when within budget', () => {
    const blocks: ContentBlock[] = [{ type: 'text', text: 'hello' }]
    const result = truncateBlocks(blocks, 1000)
    expect(result.truncated).toBe(false)
    expect(result.blocks).toEqual(blocks)
  })

  it('truncates tool_result content first (longest first)', () => {
    const blocks: ContentBlock[] = [
      { type: 'tool_result', tool_use_id: '1', content: 'x'.repeat(2000) },
      { type: 'text', text: 'keep this' },
    ]
    const result = truncateBlocks(blocks, 100)
    expect(result.truncated).toBe(true)
    const toolResult = result.blocks.find(b => b.type === 'tool_result')
    expect(typeof toolResult?.content === 'string' && toolResult.content.length).toBeLessThan(2000)
    // Text should still be intact (truncated after tool_result)
    const textBlock = result.blocks.find(b => b.type === 'text')
    expect(textBlock?.text).toBeDefined()
  })

  it('truncates tool_use input as second pass', () => {
    const blocks: ContentBlock[] = [
      { type: 'tool_use', name: 'Bash', input: { command: 'x'.repeat(2000) } },
    ]
    const result = truncateBlocks(blocks, 10)
    expect(result.truncated).toBe(true)
    const toolUse = result.blocks.find(b => b.type === 'tool_use')
    expect(toolUse?.input).toEqual({ _truncated: true })
  })
})

describe('truncateTurns', () => {
  it('drops middle turns when per-turn truncation is insufficient', () => {
    const makeTurn = (idx: number) => ({
      turnIndex: idx, turnId: `t${idx}`, role: 'assistant' as const,
      timestamp: '2026-01-01T00:00:00Z',
      contentBlocks: [{ type: 'text' as const, text: 'x'.repeat(1000) }],
      toolNames: [] as string[], isError: false, isCorrection: false,
    })
    const turns = Array.from({ length: 10 }, (_, i) => makeTurn(i))
    const result = truncateTurns(turns, 50) // Very tight budget
    expect(result.truncated).toBe(true)
    expect(result.turns.length).toBeLessThan(10)
    // First and last should be preserved
    expect(result.turns[0].turnIndex).toBe(0)
    expect(result.turns[result.turns.length - 1].turnIndex).toBe(9)
  })
})
```

Export `truncateBlocks` and `truncateTurns` from `get-turns.ts` so they're testable.

- [ ] **Step 3: Register in tools/index.ts**

Add import and call:

```typescript
import { registerGetTurns } from './get-turns'
```

Add `registerGetTurns(server)` to the `registerTools` function.

- [ ] **Step 4: Run all tests**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/get-turns.ts src/tools/get-turns.test.ts src/tools/index.ts
git commit -m "feat: add get_turns tool for full turn expansion"
```

---

### Task 8: Remove deprecated code

**Files:**
- Create: `src/services/tool-summary.ts` (extract `extractToolParams` from distiller)
- Delete: `src/services/conversation-distiller.ts`
- Delete: `src/services/conversation-distiller.test.ts`
- Modify: `src/types/session.ts` (remove `Focus` type)
- Modify: `src/services/token-budget-manager.ts` (remove `filterByWindow`)
- Modify: `src/services/index.ts` (remove distiller export)
- Modify: `src/tools/query-turns.ts` (update import to use tool-summary)

- [ ] **Step 1: Extract `extractToolParams` to shared utility**

Create `src/services/tool-summary.ts` with the `extractToolParams` function from `conversation-distiller.ts`. Update the import in `src/tools/query-turns.ts` to use the new path.

- [ ] **Step 2: Delete conversation distiller files**

```bash
rm src/services/conversation-distiller.ts src/services/conversation-distiller.test.ts
```

- [ ] **Step 2: Remove Focus type from types/session.ts**

Remove line 83: `export type Focus = 'general' | 'tools' | 'errors' | 'files' | 'decisions'`

- [ ] **Step 3: Remove filterByWindow from token-budget-manager.ts**

Remove the `filterByWindow` method and its helper `cleanContentBlocks` if they exist. Keep `fitWithinBudget` — it may still be used by other tools. Check for any remaining imports of `Focus` or `distillConversation` across the codebase and remove them.

- [ ] **Step 4: Update barrel exports in services/index.ts**

Remove the `conversation-distiller` re-export. Add exports for `turn-indexer` and `phase-clusterer`.

- [ ] **Step 5: Run all tests**

Run: `npx vitest run`
Expected: PASS — distiller tests are deleted, no remaining references

- [ ] **Step 7: Move inline types to `src/types/`**

Per project convention ("types and interfaces live in dedicated files"), move `Phase` from `phase-clusterer.ts`, `TurnReference` from `query-turns.ts`, and `ExpandedTurn` from `get-turns.ts` into `src/types/conversation.ts`. Update imports in the source files. Re-export from `src/types/index.ts`.

- [ ] **Step 8: Run all tests**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/types/conversation.ts src/types/index.ts src/services/tool-summary.ts src/services/phase-clusterer.ts src/tools/query-turns.ts src/tools/get-turns.ts src/services/conversation-distiller.ts src/services/conversation-distiller.test.ts src/types/session.ts src/services/token-budget-manager.ts src/services/index.ts
git commit -m "refactor: extract shared types, extract tool-summary, remove distiller and Focus"
```

---

### Task 9: Update CLAUDE.md tool count and descriptions

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update the Available Tools table**

Change tool count from 9 to 11. Update `get_conversation` description. Add `query_turns` and `get_turns` entries:

| Tool | Purpose |
|------|---------|
| `get_conversation` | Session overview — phase-clustered activity timeline |
| `query_turns` | Search turns by tool name, error status, text pattern, time range |
| `get_turns` | Full content for specific turns — tool inputs, outputs, text |

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update tool descriptions for conversation navigation redesign"
```

---

### Task 10: Integration smoke test

- [ ] **Step 1: Start the dev server and test the navigation flow manually**

```bash
npm run dev
```

Using an MCP client or the Claude Code session with this server configured, test:

1. `get_conversation` on a real session — verify phases are returned with turn ranges
2. `query_turns` with `toolNames=["Bash"]` on a session — verify filtered results with summaries
3. `query_turns` with `isError=true` on a session — verify error turns found
4. `get_turns` with a `turnRange` from query results — verify full content including tool inputs/outputs
5. `query_turns` with `projectId` (cross-session) — verify DB-backed query works

- [ ] **Step 2: Fix any issues found**

- [ ] **Step 3: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix: integration fixes for conversation navigation"
```
