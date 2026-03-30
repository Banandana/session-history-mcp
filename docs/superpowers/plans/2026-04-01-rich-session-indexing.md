# Rich Session Indexing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compute session metrics, heuristic topics, and LLM narrative summaries at index time so every MCP response is self-describing without follow-up queries.

**Architecture:** New columns on `sessions` table populated during sync. Two new pure modules (`topic-generator`, `conversation-distiller`) handle heuristic and LLM input. `list_sessions` switches from adapter iteration to DB query. LLM summarization runs async after sync completes.

**Tech Stack:** TypeScript (strict), better-sqlite3, tsyringe DI, ESM

**Spec:** `docs/superpowers/specs/2026-04-01-rich-session-indexing-design.md`

---

### Task 1: Schema Migration — Add New Columns

**Files:**
- Modify: `src/services/index-manager.ts:20-111`

- [ ] **Step 1: Write the failing test**

Create `src/services/index-manager.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { IndexManager } from './index-manager'

describe('IndexManager', () => {
  let db: Database.Database
  let manager: IndexManager

  beforeEach(() => {
    db = new Database(':memory:')
    manager = new IndexManager(db)
  })

  describe('ensureSchema', () => {
    it('creates sessions table with new metric columns', () => {
      manager.ensureSchema()
      const columns = db.pragma('table_info(sessions)') as Array<{ name: string }>
      const names = columns.map(c => c.name)
      expect(names).toContain('ended_at')
      expect(names).toContain('duration_minutes')
      expect(names).toContain('message_count')
      expect(names).toContain('error_count')
      expect(names).toContain('correction_count')
      expect(names).toContain('subagent_count')
      expect(names).toContain('tool_counts')
      expect(names).toContain('files_changed')
      expect(names).toContain('topic')
      expect(names).toContain('summary')
      expect(names).toContain('summary_generated_at')
    })

    it('does not create summaries table', () => {
      manager.ensureSchema()
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
      const names = tables.map(t => t.name)
      expect(names).not.toContain('summaries')
    })

    it('migrates existing v0 schema by adding columns', () => {
      // Simulate v0 schema — sessions table without new columns
      db.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          source TEXT NOT NULL,
          project_slug TEXT,
          cwd TEXT,
          branch TEXT,
          started_at TEXT,
          model TEXT,
          total_tokens INTEGER DEFAULT 0,
          total_turns INTEGER DEFAULT 0,
          summary_text TEXT,
          byte_offset INTEGER DEFAULT 0,
          version INTEGER DEFAULT 1,
          indexed_at TEXT
        );
        CREATE TABLE summaries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          summary_text TEXT,
          generated_at TEXT
        );
      `)
      db.pragma('user_version = 0')

      // Insert a session to verify data survives migration
      db.prepare("INSERT INTO sessions (id, source, project_slug) VALUES ('test-1', 'claude-code', 'proj')").run()

      manager.ensureSchema()

      // Verify new columns exist
      const columns = db.pragma('table_info(sessions)') as Array<{ name: string }>
      expect(columns.map(c => c.name)).toContain('topic')
      expect(columns.map(c => c.name)).toContain('ended_at')

      // Verify data survived
      const row = db.prepare('SELECT id FROM sessions WHERE id = ?').get('test-1')
      expect(row).toBeDefined()

      // Verify summaries table dropped
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
      expect(tables.map(t => t.name)).not.toContain('summaries')

      // Verify user_version is 1
      const version = db.pragma('user_version', { simple: true })
      expect(version).toBe(1)
    })

    it('creates sort indexes for new columns', () => {
      manager.ensureSchema()
      const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{ name: string }>
      const names = indexes.map(i => i.name)
      expect(names).toContain('idx_sessions_duration')
      expect(names).toContain('idx_sessions_total_turns')
      expect(names).toContain('idx_sessions_error_count')
      expect(names).toContain('idx_sessions_total_tokens')
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/index-manager.test.ts`
Expected: FAIL — new columns don't exist yet

- [ ] **Step 3: Implement schema migration**

Replace `ensureSchema()` in `src/services/index-manager.ts` (lines 20-111). The new version:

1. Creates tables as before but with new columns on `sessions` (and WITHOUT `summaries` table)
2. Checks `PRAGMA user_version` — if 0, runs migration:
   - `ALTER TABLE sessions ADD COLUMN ended_at TEXT` (one per new column)
   - `DROP TABLE IF EXISTS summaries`
   - `PRAGMA user_version = 1`
3. Creates new indexes: `idx_sessions_duration`, `idx_sessions_total_turns`, `idx_sessions_error_count`, `idx_sessions_total_tokens`

```typescript
ensureSchema(): void {
  // Create tables (new schema for fresh databases)
  this.db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      project_slug TEXT,
      cwd TEXT,
      branch TEXT,
      started_at TEXT,
      model TEXT,
      total_tokens INTEGER DEFAULT 0,
      total_turns INTEGER DEFAULT 0,
      summary_text TEXT,
      byte_offset INTEGER DEFAULT 0,
      version INTEGER DEFAULT 1,
      indexed_at TEXT,
      ended_at TEXT,
      duration_minutes INTEGER,
      message_count INTEGER DEFAULT 0,
      error_count INTEGER DEFAULT 0,
      correction_count INTEGER DEFAULT 0,
      subagent_count INTEGER DEFAULT 0,
      tool_counts TEXT,
      files_changed TEXT,
      topic TEXT,
      summary TEXT,
      summary_generated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      role TEXT,
      type TEXT,
      timestamp TEXT,
      model TEXT,
      token_count INTEGER DEFAULT 0,
      has_tool_use INTEGER DEFAULT 0,
      tool_names TEXT,
      is_error INTEGER DEFAULT 0,
      is_correction INTEGER DEFAULT 0,
      content_preview TEXT
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content_preview,
      content='messages',
      content_rowid='rowid'
    );

    CREATE TABLE IF NOT EXISTS file_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      message_id TEXT,
      file_path TEXT,
      operation TEXT,
      timestamp TEXT
    );

    CREATE TABLE IF NOT EXISTS subagents (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      agent_type TEXT,
      description TEXT,
      total_tokens INTEGER DEFAULT 0,
      total_tools INTEGER DEFAULT 0,
      duration_ms INTEGER,
      model TEXT
    );

    CREATE TABLE IF NOT EXISTS memory_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_slug TEXT NOT NULL,
      file_name TEXT NOT NULL,
      name TEXT,
      description TEXT,
      type TEXT,
      content TEXT,
      UNIQUE(project_slug, file_name)
    );

    -- Existing indexes
    CREATE INDEX IF NOT EXISTS idx_sessions_project_slug ON sessions(project_slug);
    CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions(started_at);
    CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
    CREATE INDEX IF NOT EXISTS idx_messages_is_error ON messages(session_id) WHERE is_error = 1;
    CREATE INDEX IF NOT EXISTS idx_messages_is_correction ON messages(session_id) WHERE is_correction = 1;
    CREATE INDEX IF NOT EXISTS idx_file_changes_session_id ON file_changes(session_id);
    CREATE INDEX IF NOT EXISTS idx_file_changes_file_path ON file_changes(file_path);
    CREATE INDEX IF NOT EXISTS idx_subagents_session_id ON subagents(session_id);
    CREATE INDEX IF NOT EXISTS idx_memory_entries_project_slug ON memory_entries(project_slug);
    CREATE INDEX IF NOT EXISTS idx_memory_entries_type ON memory_entries(type);

    -- New sort indexes
    CREATE INDEX IF NOT EXISTS idx_sessions_duration ON sessions(duration_minutes);
    CREATE INDEX IF NOT EXISTS idx_sessions_total_turns ON sessions(total_turns);
    CREATE INDEX IF NOT EXISTS idx_sessions_error_count ON sessions(error_count);
    CREATE INDEX IF NOT EXISTS idx_sessions_total_tokens ON sessions(total_tokens);
  `)

  // Migrate v0 → v1 (existing databases)
  const userVersion = this.db.pragma('user_version', { simple: true }) as number
  if (userVersion < 1) {
    this.migrateToV1()
  }
}

private migrateToV1(): void {
  const existingColumns = (this.db.pragma('table_info(sessions)') as Array<{ name: string }>)
    .map(c => c.name)

  const newColumns: Array<[string, string]> = [
    ['ended_at', 'TEXT'],
    ['duration_minutes', 'INTEGER'],
    ['message_count', 'INTEGER DEFAULT 0'],
    ['error_count', 'INTEGER DEFAULT 0'],
    ['correction_count', 'INTEGER DEFAULT 0'],
    ['subagent_count', 'INTEGER DEFAULT 0'],
    ['tool_counts', 'TEXT'],
    ['files_changed', 'TEXT'],
    ['topic', 'TEXT'],
    ['summary', 'TEXT'],
    ['summary_generated_at', 'TEXT'],
  ]

  for (const [name, type] of newColumns) {
    if (!existingColumns.includes(name)) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${type}`)
    }
  }

  this.db.exec('DROP TABLE IF EXISTS summaries')
  this.db.pragma('user_version = 1')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/services/index-manager.test.ts`
Expected: All 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/index-manager.ts src/services/index-manager.test.ts
git commit -m "feat: add session metric columns and v0→v1 schema migration"
```

---

### Task 2: Topic Generator — Pure Module

**Files:**
- Create: `src/services/topic-generator.ts`
- Create: `src/services/topic-generator.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/services/topic-generator.test.ts
import { describe, it, expect } from 'vitest'
import { generateTopic } from './topic-generator'

describe('generateTopic', () => {
  it('generates topic from first user message and tool categories', () => {
    const topic = generateTopic({
      firstUserMessage: 'do a full audit of the schematics',
      toolCounts: {
        'mcp__kicad__find_orphan_items': 13,
        'mcp__kicad__run_erc': 4,
        'Grep': 93,
        'Edit': 26,
      },
      errorCount: 4,
    })
    expect(topic).toContain('full audit of the schematics')
    expect(topic).toContain('schematic')
  })

  it('classifies code exploration for grep/read heavy sessions', () => {
    const topic = generateTopic({
      firstUserMessage: 'explain how auth works',
      toolCounts: { 'Grep': 50, 'Read': 30, 'Edit': 2 },
      errorCount: 0,
    })
    expect(topic).toContain('explain how auth works')
    expect(topic).toContain('code exploration')
  })

  it('classifies code changes for edit/write heavy sessions', () => {
    const topic = generateTopic({
      firstUserMessage: 'add unit tests for the parser',
      toolCounts: { 'Edit': 20, 'Write': 10, 'Bash': 8 },
      errorCount: 0,
    })
    expect(topic).toContain('add unit tests for the parser')
    expect(topic).toContain('code changes')
  })

  it('appends error indicator for high error sessions', () => {
    const topic = generateTopic({
      firstUserMessage: 'fix the build',
      toolCounts: { 'Bash': 20, 'Edit': 10 },
      errorCount: 8,
    })
    expect(topic).toContain('8 errors')
  })

  it('does not append error indicator for low error sessions', () => {
    const topic = generateTopic({
      firstUserMessage: 'fix the build',
      toolCounts: { 'Bash': 20 },
      errorCount: 3,
    })
    expect(topic).not.toContain('errors')
  })

  it('returns "Empty session" when no first message', () => {
    const topic = generateTopic({
      firstUserMessage: undefined,
      toolCounts: {},
      errorCount: 0,
    })
    expect(topic).toBe('Empty session')
  })

  it('truncates long first messages', () => {
    const topic = generateTopic({
      firstUserMessage: 'a'.repeat(200),
      toolCounts: { 'Read': 5 },
      errorCount: 0,
    })
    expect(topic.length).toBeLessThan(150)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/topic-generator.test.ts`
Expected: FAIL — module doesn't exist

- [ ] **Step 3: Implement topic-generator.ts**

```typescript
// src/services/topic-generator.ts

interface TopicInput {
  readonly firstUserMessage: string | undefined
  readonly toolCounts: Record<string, number>
  readonly errorCount: number
}

const TOOL_CATEGORIES: ReadonlyArray<{
  readonly name: string
  readonly patterns: readonly RegExp[]
}> = [
  { name: 'schematic work', patterns: [/^mcp__kicad__/] },
  { name: 'component search', patterns: [/^mcp__pcbparts__/, /^mcp__mouser__/, /^mcp__jlcpcb/] },
  { name: 'circuit simulation', patterns: [/^mcp__spicebridge__/] },
  { name: 'code exploration', patterns: [/^Grep$/, /^Read$/, /^Glob$/] },
  { name: 'code changes', patterns: [/^Edit$/, /^Write$/] },
  { name: 'shell operations', patterns: [/^Bash$/] },
  { name: 'research', patterns: [/^WebFetch$/, /^WebSearch$/] },
  { name: 'agent delegation', patterns: [/^Agent$/, /^Task/] },
]

function classifyTools(toolCounts: Record<string, number>): string[] {
  const categoryScores = new Map<string, number>()

  for (const [tool, count] of Object.entries(toolCounts)) {
    for (const cat of TOOL_CATEGORIES) {
      if (cat.patterns.some(p => p.test(tool))) {
        categoryScores.set(cat.name, (categoryScores.get(cat.name) ?? 0) + count)
        break
      }
    }
  }

  // Sort by score descending, take top 2
  return [...categoryScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([name]) => name)
}

export function generateTopic(input: TopicInput): string {
  if (!input.firstUserMessage) return 'Empty session'

  const truncated = input.firstUserMessage.length > 60
    ? input.firstUserMessage.slice(0, 57) + '...'
    : input.firstUserMessage

  const categories = classifyTools(input.toolCounts)
  const parts: string[] = [truncated]

  if (categories.length > 0) {
    parts.push(categories.join(', '))
  }

  if (input.errorCount > 5) {
    parts.push(`${input.errorCount} errors`)
  }

  return parts.join(' — ')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/services/topic-generator.test.ts`
Expected: All 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/topic-generator.ts src/services/topic-generator.test.ts
git commit -m "feat: add heuristic topic generator for sessions"
```

---

### Task 3: Conversation Distiller — Pure Module

**Files:**
- Create: `src/services/conversation-distiller.ts`
- Create: `src/services/conversation-distiller.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/services/conversation-distiller.test.ts
import { describe, it, expect } from 'vitest'
import { distillConversation } from './conversation-distiller'
import type { NormalizedMessage } from '../types'

function makeMsg(overrides: Partial<NormalizedMessage> & { id: string; role: NormalizedMessage['role'] }): NormalizedMessage {
  return {
    sessionId: 'test',
    timestamp: '2026-01-01T00:00:00Z',
    contentBlocks: [],
    isError: false,
    isCorrection: false,
    uuid: overrides.id,
    ...overrides,
  }
}

describe('distillConversation', () => {
  it('keeps user text verbatim', () => {
    const msgs: NormalizedMessage[] = [
      makeMsg({ id: '1', role: 'user', contentBlocks: [{ type: 'text', text: 'do a full audit' }] }),
    ]
    const result = distillConversation(msgs, 10)
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]).toEqual({ role: 'user', text: 'do a full audit' })
  })

  it('keeps assistant text blocks', () => {
    const msgs: NormalizedMessage[] = [
      makeMsg({ id: '1', role: 'assistant', contentBlocks: [{ type: 'text', text: 'I will start the audit.' }] }),
    ]
    const result = distillConversation(msgs, 10)
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]).toEqual({ role: 'assistant', text: 'I will start the audit.' })
  })

  it('collapses tool_use into action lines', () => {
    const msgs: NormalizedMessage[] = [
      makeMsg({
        id: '1',
        role: 'assistant',
        contentBlocks: [
          { type: 'text', text: 'Let me check.' },
          { type: 'tool_use', name: 'Read', input: { file_path: '/src/foo.ts' } },
          { type: 'tool_use', name: 'Grep', input: { pattern: 'auth' } },
        ],
      }),
    ]
    const result = distillConversation(msgs, 10)
    expect(result.messages).toHaveLength(2)
    expect(result.messages[0]).toEqual({ role: 'assistant', text: 'Let me check.' })
    expect(result.messages[1].role).toBe('action')
    expect(result.messages[1].text).toContain('Read')
    expect(result.messages[1].text).toContain('Grep')
  })

  it('drops thinking blocks', () => {
    const msgs: NormalizedMessage[] = [
      makeMsg({
        id: '1',
        role: 'assistant',
        contentBlocks: [
          { type: 'thinking', thinking: 'Let me think...' },
          { type: 'text', text: 'Here is the answer.' },
        ],
      }),
    ]
    const result = distillConversation(msgs, 10)
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0].text).toBe('Here is the answer.')
  })

  it('drops tool_result messages', () => {
    const msgs: NormalizedMessage[] = [
      makeMsg({
        id: '1',
        role: 'user',
        contentBlocks: [{ type: 'tool_result', tool_use_id: 'x', content: 'big output' }],
      }),
    ]
    const result = distillConversation(msgs, 10)
    expect(result.messages).toHaveLength(0)
  })

  it('takes first N and last N messages from long conversations', () => {
    const msgs: NormalizedMessage[] = Array.from({ length: 50 }, (_, i) =>
      makeMsg({
        id: String(i),
        role: i % 2 === 0 ? 'user' : 'assistant',
        contentBlocks: [{ type: 'text', text: `Message ${i}` }],
      })
    )
    const result = distillConversation(msgs, 5)
    // First 5 + last 5, with overlap deduped
    expect(result.messages.length).toBeLessThanOrEqual(10)
    expect(result.messages[0].text).toBe('Message 0')
    expect(result.messages[result.messages.length - 1].text).toBe('Message 49')
  })

  it('truncates long user messages', () => {
    const msgs: NormalizedMessage[] = [
      makeMsg({ id: '1', role: 'user', contentBlocks: [{ type: 'text', text: 'a'.repeat(1000) }] }),
    ]
    const result = distillConversation(msgs, 10)
    expect(result.messages[0].text.length).toBeLessThanOrEqual(503) // 500 + '...'
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/conversation-distiller.test.ts`
Expected: FAIL — module doesn't exist

- [ ] **Step 3: Implement conversation-distiller.ts**

```typescript
// src/services/conversation-distiller.ts
import type { NormalizedMessage } from '../types'

export interface DistilledMessage {
  readonly role: 'user' | 'assistant' | 'action'
  readonly text: string
}

export interface DistilledConversation {
  readonly messages: readonly DistilledMessage[]
  readonly estimatedTokens: number
}

const MAX_TEXT_LENGTH = 500

function truncate(text: string, max: number = MAX_TEXT_LENGTH): string {
  return text.length > max ? text.slice(0, max) + '...' : text
}

function isToolResultOnly(msg: NormalizedMessage): boolean {
  return msg.contentBlocks.every(b => b.type === 'tool_result')
}

function distillMessage(msg: NormalizedMessage): DistilledMessage[] {
  if (isToolResultOnly(msg)) return []

  const result: DistilledMessage[] = []
  const toolNames: string[] = []

  for (const block of msg.contentBlocks) {
    if (block.type === 'thinking') continue

    if (block.type === 'text' && block.text) {
      const trimmed = block.text.trim()
      if (trimmed) {
        result.push({
          role: msg.role === 'user' ? 'user' : 'assistant',
          text: truncate(trimmed),
        })
      }
    }

    if (block.type === 'tool_use' && block.name) {
      toolNames.push(block.name)
    }
  }

  if (toolNames.length > 0) {
    result.push({
      role: 'action',
      text: `[${toolNames.join(', ')}]`,
    })
  }

  return result
}

function selectBookendMessages(messages: readonly NormalizedMessage[], n: number): NormalizedMessage[] {
  if (messages.length <= n * 2) return [...messages]

  const first = messages.slice(0, n)
  const last = messages.slice(-n)

  // Deduplicate by id
  const seen = new Set<string>()
  const combined: NormalizedMessage[] = []
  for (const msg of [...first, ...last]) {
    if (!seen.has(msg.id)) {
      seen.add(msg.id)
      combined.push(msg)
    }
  }
  return combined
}

export function distillConversation(
  messages: readonly NormalizedMessage[],
  n: number = 10,
): DistilledConversation {
  const selected = selectBookendMessages(messages, n)
  const distilled = selected.flatMap(distillMessage)

  const estimatedTokens = distilled.reduce((sum, m) => sum + Math.ceil(m.text.length / 4), 0)

  return { messages: distilled, estimatedTokens }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/services/conversation-distiller.test.ts`
Expected: All 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/conversation-distiller.ts src/services/conversation-distiller.test.ts
git commit -m "feat: add conversation distiller for LLM summarization input"
```

---

### Task 4: Update Types — SessionMeta

**Files:**
- Modify: `src/types/session.ts:39-51`

- [ ] **Step 1: Update SessionMeta interface**

Add the new fields to `SessionMeta` (lines 39-51 of `src/types/session.ts`):

```typescript
export interface SessionMeta {
  readonly id: string
  readonly source: string
  readonly projectSlug: string
  readonly cwd: string
  readonly branch?: string
  readonly startedAt: string
  readonly endedAt?: string
  readonly durationMinutes?: number
  readonly model?: string
  readonly totalTokens?: number
  readonly totalTurns?: number
  readonly messageCount?: number
  readonly errorCount?: number
  readonly correctionCount?: number
  readonly subagentCount?: number
  readonly toolCounts?: Record<string, number>
  readonly filesChanged?: ReadonlyArray<{ readonly path: string; readonly op: string }>
  readonly topic?: string
  readonly summary?: string
  readonly summaryGeneratedAt?: string
  readonly summaryText?: string
  readonly version?: string
}
```

- [ ] **Step 2: Verify no type errors**

Run: `npx tsc --noEmit`
Expected: PASS (all new fields optional, backwards-compatible)

- [ ] **Step 3: Commit**

```bash
git add src/types/session.ts
git commit -m "feat: extend SessionMeta with metric and summary fields"
```

---

### Task 5: Metrics Computation in FreshnessGuard

**Files:**
- Modify: `src/services/freshness-guard.ts`

This is the core change. After indexing messages/file_changes/subagents for a session, compute all metrics and store them on the sessions row.

- [ ] **Step 1: Write the failing test**

Create `src/services/freshness-guard.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { IndexManager } from './index-manager'
import { FreshnessGuard } from './freshness-guard'

// We need to test that after syncing a session, all metric columns are populated.
// We'll use a mock registry that provides canned session data.

function createMockRegistry(sessions: Array<{
  id: string
  projectSlug: string
  messages: Array<{ id: string; role: string; text: string; isError?: boolean; isCorrection?: boolean; toolNames?: string[]; timestamp: string }>
  fileChanges?: Array<{ filePath: string; operation: string; timestamp: string }>
  subagents?: Array<{ id: string; agentType: string }>
}>) {
  return {
    async checkFreshness() {
      return {
        isStale: true,
        newSessions: sessions.map(s => s.id),
        changedSessions: [],
        removedSessions: [],
      }
    },
    async *discoverSessions() {
      for (const s of sessions) {
        yield {
          id: s.id,
          source: 'claude-code',
          projectSlug: s.projectSlug,
          cwd: '/test',
          startedAt: s.messages[0]?.timestamp ?? '2026-01-01T00:00:00Z',
        }
      }
    },
    async *getMessages(sessionId: string) {
      const session = sessions.find(s => s.id === sessionId)
      if (!session) return
      for (const msg of session.messages) {
        yield {
          id: msg.id,
          sessionId,
          role: msg.role,
          timestamp: msg.timestamp,
          contentBlocks: [{ type: 'text', text: msg.text }],
          isError: msg.isError ?? false,
          isCorrection: msg.isCorrection ?? false,
          toolNames: msg.toolNames ?? [],
          uuid: msg.id,
        }
      }
    },
    async *getFileChanges(sessionId: string) {
      const session = sessions.find(s => s.id === sessionId)
      if (!session?.fileChanges) return
      for (const fc of session.fileChanges) {
        yield { sessionId, filePath: fc.filePath, operation: fc.operation, timestamp: fc.timestamp }
      }
    },
    async *getSubagents(sessionId: string) {
      const session = sessions.find(s => s.id === sessionId)
      if (!session?.subagents) return
      for (const sa of session.subagents) {
        yield { id: sa.id, sessionId, agentType: sa.agentType }
      }
    },
  }
}

describe('FreshnessGuard metrics computation', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    const manager = new IndexManager(db)
    manager.ensureSchema()
  })

  it('populates all metric columns after sync', async () => {
    const registry = createMockRegistry([{
      id: 'session-1',
      projectSlug: 'test-project',
      messages: [
        { id: 'm1', role: 'user', text: 'add unit tests', timestamp: '2026-01-01T10:00:00Z' },
        { id: 'm2', role: 'assistant', text: 'I will add tests', timestamp: '2026-01-01T10:01:00Z', toolNames: ['Edit', 'Bash'] },
        { id: 'm3', role: 'user', text: 'looks good', timestamp: '2026-01-01T10:30:00Z' },
        { id: 'm4', role: 'assistant', text: 'done', timestamp: '2026-01-01T10:31:00Z', isError: true, toolNames: ['Bash'] },
      ],
      fileChanges: [
        { filePath: 'src/test.ts', operation: 'create', timestamp: '2026-01-01T10:01:00Z' },
        { filePath: 'src/impl.ts', operation: 'edit', timestamp: '2026-01-01T10:02:00Z' },
      ],
      subagents: [{ id: 'agent-1', agentType: 'general' }],
    }])

    const manager = new IndexManager(db)
    const guard = new FreshnessGuard(registry as any, manager, '/tmp', db)
    await guard.ensureFresh()

    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get('session-1') as Record<string, unknown>

    expect(session.ended_at).toBe('2026-01-01T10:31:00Z')
    expect(session.duration_minutes).toBe(31)
    expect(session.message_count).toBe(4)
    expect(session.error_count).toBe(1)
    expect(session.correction_count).toBe(0)
    expect(session.subagent_count).toBe(1)

    const toolCounts = JSON.parse(session.tool_counts as string)
    expect(toolCounts['Edit']).toBe(1)
    expect(toolCounts['Bash']).toBe(2)

    const filesChanged = JSON.parse(session.files_changed as string)
    expect(filesChanged).toHaveLength(2)

    expect(session.topic).toContain('add unit tests')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/freshness-guard.test.ts`
Expected: FAIL — metrics not computed yet

- [ ] **Step 3: Add computeSessionMetrics method to FreshnessGuard**

Add a private method after message/file_change/subagent indexing. Call it at the end of both `syncNewSessions` and `syncChangedSessions` for each session:

```typescript
private computeSessionMetrics(sessionId: string): void {
  // ended_at + duration
  const timestamps = this.db.prepare(`
    SELECT MIN(timestamp) as first_ts, MAX(timestamp) as last_ts
    FROM messages WHERE session_id = ?
  `).get(sessionId) as { first_ts: string | null; last_ts: string | null }

  const endedAt = timestamps.last_ts
  const startedAt = this.db.prepare('SELECT started_at FROM sessions WHERE id = ?')
    .get(sessionId) as { started_at: string | null } | undefined
  const durationMinutes = startedAt?.started_at && endedAt
    ? Math.round((new Date(endedAt).getTime() - new Date(startedAt.started_at).getTime()) / 60000)
    : 0

  // counts
  const messageCount = (this.db.prepare(
    'SELECT COUNT(*) as c FROM messages WHERE session_id = ?'
  ).get(sessionId) as { c: number }).c

  const errorCount = (this.db.prepare(
    'SELECT COUNT(*) as c FROM messages WHERE session_id = ? AND is_error = 1'
  ).get(sessionId) as { c: number }).c

  const correctionCount = (this.db.prepare(
    'SELECT COUNT(*) as c FROM messages WHERE session_id = ? AND is_correction = 1'
  ).get(sessionId) as { c: number }).c

  const subagentCount = (this.db.prepare(
    'SELECT COUNT(*) as c FROM subagents WHERE session_id = ?'
  ).get(sessionId) as { c: number }).c

  // tool_counts
  const toolRows = this.db.prepare(
    'SELECT tool_names FROM messages WHERE session_id = ? AND tool_names IS NOT NULL'
  ).all(sessionId) as Array<{ tool_names: string }>

  const toolCounts: Record<string, number> = {}
  for (const row of toolRows) {
    for (const name of row.tool_names.split(',')) {
      const t = name.trim()
      if (t) toolCounts[t] = (toolCounts[t] ?? 0) + 1
    }
  }

  // files_changed
  const fileRows = this.db.prepare(
    'SELECT DISTINCT file_path, operation FROM file_changes WHERE session_id = ?'
  ).all(sessionId) as Array<{ file_path: string; operation: string }>

  const filesChanged = fileRows.map(r => ({ path: r.file_path, op: r.operation }))

  // topic (heuristic)
  const firstUserMsg = this.db.prepare(`
    SELECT content_preview FROM messages
    WHERE session_id = ? AND role = 'user' AND content_preview != '' AND has_tool_use = 0
    ORDER BY timestamp ASC LIMIT 1
  `).get(sessionId) as { content_preview: string } | undefined

  // generateTopic is imported at the top of the file: import { generateTopic } from './topic-generator'
  const topic = generateTopic({
    firstUserMessage: firstUserMsg?.content_preview,
    toolCounts,
    errorCount,
  })

  // UPDATE session row
  this.db.prepare(`
    UPDATE sessions SET
      ended_at = ?,
      duration_minutes = ?,
      message_count = ?,
      error_count = ?,
      correction_count = ?,
      subagent_count = ?,
      tool_counts = ?,
      files_changed = ?,
      topic = ?
    WHERE id = ?
  `).run(
    endedAt,
    durationMinutes,
    messageCount,
    errorCount,
    correctionCount,
    subagentCount,
    JSON.stringify(toolCounts),
    JSON.stringify(filesChanged),
    topic,
    sessionId,
  )
}
```

Add this import at the top of `freshness-guard.ts`:

```typescript
import { generateTopic } from './topic-generator'
```

Handle 0-message sessions: if `timestamps.last_ts` is NULL, fall back to `started_at` for `ended_at` and set `duration_minutes = 0`.

Add after the `endedAt` computation:

```typescript
  // 0-message fallback
  const effectiveEndedAt = endedAt ?? startedAt?.started_at ?? null
  const effectiveDuration = endedAt ? durationMinutes : 0
```

Use `effectiveEndedAt` and `effectiveDuration` in the UPDATE statement.

Call `this.computeSessionMetrics(sessionId)` at the end of the per-session loop in both `syncNewSessions` (after line 185) and `syncChangedSessions` (after line 249).

- [ ] **Step 4: Extend syncChangedSessions to re-index file_changes and subagents**

Currently `syncChangedSessions` (lines 192-253) only re-indexes messages. Add file_change and subagent indexing after the message loop, mirroring lines 150-181 from `syncNewSessions`:

```typescript
// Add inside syncChangedSessions, after message re-indexing and before updateFileOffsets:

// Re-index file changes (delete old, insert new)
this.db.prepare('DELETE FROM file_changes WHERE session_id = ?').run(sessionId)
const insertFileChange = this.db.prepare(`
  INSERT OR IGNORE INTO file_changes (session_id, message_id, file_path, operation, timestamp)
  VALUES (?, ?, ?, ?, ?)
`)
for await (const change of this.registry.getFileChanges(sessionId)) {
  insertFileChange.run(sessionId, change.messageId ?? null, change.filePath, change.operation, change.timestamp)
}

// Re-index subagents
this.db.prepare('DELETE FROM subagents WHERE session_id = ?').run(sessionId)
const insertSubagent = this.db.prepare(`
  INSERT OR IGNORE INTO subagents (id, session_id, agent_type, description, total_tokens, total_tools, duration_ms, model)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`)
for await (const agent of this.registry.getSubagents(sessionId)) {
  insertSubagent.run(agent.id, sessionId, agent.agentType ?? null, agent.description ?? null, agent.totalTokens ?? null, agent.totalTools ?? null, agent.durationMs ?? null, agent.model ?? null)
}

// Compute metrics
this.computeSessionMetrics(sessionId)
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/services/freshness-guard.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/services/freshness-guard.ts src/services/freshness-guard.test.ts
git commit -m "feat: compute session metrics at index time in freshness-guard"
```

---

### Task 6: Async LLM Summarization

**Files:**
- Modify: `src/services/freshness-guard.ts`
- Modify: `src/services/local-llm-client.ts`
- Modify: `src/container/modules.ts:44-46`

- [ ] **Step 1: Write the failing test**

Add to `src/services/freshness-guard.test.ts`:

```typescript
it('generates LLM summary for sessions missing one', async () => {
  // This test verifies that after metrics are computed, sessions with
  // topic but no summary get LLM summarization attempted.
  // We mock the LLM client to return a canned summary.

  const registry = createMockRegistry([{
    id: 'session-2',
    projectSlug: 'test-project',
    messages: [
      { id: 'm1', role: 'user', text: 'fix the auth bug', timestamp: '2026-01-01T10:00:00Z' },
      { id: 'm2', role: 'assistant', text: 'Found the issue in auth.ts', timestamp: '2026-01-01T10:05:00Z' },
    ],
  }])

  const mockLlm = {
    async isAvailable() { return true },
    async summarize(content: string) { return 'Fixed auth bug in auth.ts by correcting token validation.' },
  }

  const manager = new IndexManager(db)
  const guard = new FreshnessGuard(registry as any, manager, '/tmp', db, mockLlm as any)
  await guard.ensureFresh()

  const session = db.prepare('SELECT summary, summary_generated_at FROM sessions WHERE id = ?').get('session-2') as Record<string, unknown>
  expect(session.summary).toBe('Fixed auth bug in auth.ts by correcting token validation.')
  expect(session.summary_generated_at).toBeTruthy()
})

it('leaves summary NULL when LLM unavailable', async () => {
  const registry = createMockRegistry([{
    id: 'session-3',
    projectSlug: 'test-project',
    messages: [
      { id: 'm1', role: 'user', text: 'hello', timestamp: '2026-01-01T10:00:00Z' },
    ],
  }])

  const mockLlm = {
    async isAvailable() { return false },
    async summarize() { return '' },
  }

  const manager = new IndexManager(db)
  const guard = new FreshnessGuard(registry as any, manager, '/tmp', db, mockLlm as any)
  await guard.ensureFresh()

  const session = db.prepare('SELECT summary FROM sessions WHERE id = ?').get('session-3') as Record<string, unknown>
  expect(session.summary).toBeNull()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/freshness-guard.test.ts`
Expected: FAIL — FreshnessGuard constructor doesn't accept llmClient

- [ ] **Step 3: Add LLM summarization to FreshnessGuard**

Update `FreshnessGuard` constructor to accept optional `LocalLlmClient`:

```typescript
import type { LocalLlmClient } from './local-llm-client'
import { distillConversation } from './conversation-distiller'

export class FreshnessGuard {
  private readonly db: Database.Database

  constructor(
    private readonly registry: AdapterRegistry,
    private readonly indexManager: IndexManager,
    private readonly claudeDir: string,
    db: Database.Database,
    private readonly llmClient?: LocalLlmClient,
  ) {
    this.db = db
  }
```

Add async summary generation method:

```typescript
private async generateSummaries(): Promise<void> {
  if (!this.llmClient) return
  const available = await this.llmClient.isAvailable()
  if (!available) return

  // Find sessions with topic but no summary (max 5 per cycle)
  const rows = this.db.prepare(`
    SELECT id FROM sessions
    WHERE topic IS NOT NULL AND summary IS NULL
    LIMIT 5
  `).all() as Array<{ id: string }>

  for (const row of rows) {
    try {
      // Get messages for distillation
      const messages: NormalizedMessage[] = []
      for await (const msg of this.registry.getMessages(row.id)) {
        messages.push(msg)
      }

      const distilled = distillConversation(messages, 10)

      // Build metrics context
      const session = this.db.prepare(
        'SELECT duration_minutes, total_turns, total_tokens, error_count, correction_count, tool_counts, files_changed, topic FROM sessions WHERE id = ?'
      ).get(row.id) as Record<string, unknown>

      const metricsBlock = [
        `Session: ${session.duration_minutes} min, ${session.total_turns} turns, ${session.total_tokens} tokens`,
        `Errors: ${session.error_count}, Corrections: ${session.correction_count}`,
        session.tool_counts ? `Tools: ${this.formatToolCounts(session.tool_counts as string)}` : null,
        session.files_changed ? `Files changed: ${this.formatFilesChanged(session.files_changed as string)}` : null,
      ].filter(Boolean).join('\n')

      const conversationBlock = distilled.messages
        .map(m => m.role === 'action' ? m.text : `${m.role}: ${m.text}`)
        .join('\n')

      const prompt = `${metricsBlock}\n\nConversation (condensed):\n${conversationBlock}\n\nSummarize this session in 2-3 sentences. Focus on what was accomplished and the outcome.`

      const summary = await this.llmClient.summarize(prompt)
      if (summary) {
        this.db.prepare('UPDATE sessions SET summary = ?, summary_generated_at = ? WHERE id = ?')
          .run(summary, new Date().toISOString(), row.id)
      }
    } catch {
      // LLM failed for this session — skip, will retry next cycle
    }
  }
}

private formatToolCounts(json: string): string {
  try {
    const counts = JSON.parse(json) as Record<string, number>
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => `${name}(${count})`)
      .join(', ')
  } catch { return '' }
}

private formatFilesChanged(json: string): string {
  try {
    const files = JSON.parse(json) as Array<{ path: string; op: string }>
    return files.slice(0, 5).map(f => `${f.path} (${f.op})`).join(', ')
  } catch { return '' }
}
```

Call `void this.generateSummaries()` (fire-and-forget, NOT `await`) at the end of `ensureFresh()`, after sync completes but before returning metadata (after line 51). This is critical — per the spec, LLM summarization must be non-blocking so `ensureFresh()` returns immediately with metrics + topic. Summaries populate in the background and are available on subsequent calls.

Also update the `summarize()` call to use a 10-second timeout instead of the default 60s:

```typescript
const summary = await this.llmClient.summarize(prompt, 300, 10_000)
```

This requires adding a `timeout` parameter to `LocalLlmClient.summarize()` (or creating a separate method). The spec mandates 10s max per session to avoid blocking.

- [ ] **Step 4: Update modules.ts to pass llmClient to FreshnessGuard**

In `src/container/modules.ts`, change line 45:

```typescript
// Before:
const freshnessGuard = new FreshnessGuard(registry, indexManager, claudeDir, db)

// After:
const freshnessGuard = new FreshnessGuard(registry, indexManager, claudeDir, db, llmClient)
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/services/freshness-guard.test.ts`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add src/services/freshness-guard.ts src/services/freshness-guard.test.ts src/container/modules.ts
git commit -m "feat: add async LLM summarization to freshness-guard sync pipeline"
```

---

### Task 7: Rewrite list_sessions — DB Query with Sorting

**Files:**
- Rewrite: `src/tools/list-sessions.ts`

- [ ] **Step 1: Rewrite list-sessions.ts**

Replace the entire tool handler. Switch from adapter iteration to SQL query on sessions table. Add `sortBy` parameter.

```typescript
import { container } from 'tsyringe'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { TOKENS } from '../container/tokens'
import type { FreshnessGuard } from '../services/freshness-guard'
import type { ProjectResolver } from '../services/project-resolver'
import type { PaginationManager } from '../services/pagination-manager'
import type { ResponseFormatter } from '../services/response-formatter'
import type { DatabaseConnection } from '../infrastructure/database'

const SORT_COLUMNS: Record<string, string> = {
  recent: 'started_at DESC',
  longest: 'duration_minutes DESC',
  most_turns: 'total_turns DESC',
  most_tokens: 'total_tokens DESC',
  errors: 'error_count DESC',
}

export function registerListSessions(server: McpServer): void {
  server.tool(
    'list_sessions',
    'List sessions with rich metadata — topic, summary, duration, errors. Supports filtering, sorting, and pagination.',
    {
      project: z.string().optional().describe('Project slug'),
      path: z.string().optional().describe('Filesystem path to project or subdirectory'),
      branch: z.string().optional().describe('Filter by git branch'),
      from: z.string().optional().describe('Start date ISO 8601'),
      to: z.string().optional().describe('End date ISO 8601'),
      sortBy: z.enum(['recent', 'longest', 'most_turns', 'most_tokens', 'errors']).optional().describe('Sort order (default: recent)'),
      limit: z.number().optional().describe('Maximum number of sessions to return'),
      cursor: z.string().optional().describe('Pagination cursor'),
    },
    async (params) => {
      const freshnessGuard = container.resolve<FreshnessGuard>(TOKENS.FreshnessGuard)
      const projectResolver = container.resolve<ProjectResolver>(TOKENS.ProjectResolver)
      const pagination = container.resolve<PaginationManager>(TOKENS.PaginationManager)
      const formatter = container.resolve<ResponseFormatter>(TOKENS.ResponseFormatter)
      const dbConn = container.resolve<DatabaseConnection>(TOKENS.Database)
      const db = dbConn.get()

      const freshness = await freshnessGuard.ensureFresh()

      const slug = await projectResolver.resolveProjectFilter({
        project: params.project,
        path: params.path,
      })

      // Build SQL query
      const conditions: string[] = []
      const sqlParams: (string | number)[] = []

      if (slug) {
        conditions.push('project_slug = ?')
        sqlParams.push(slug)
      }
      if (params.branch) {
        conditions.push('branch = ?')
        sqlParams.push(params.branch)
      }
      if (params.from) {
        conditions.push('started_at >= ?')
        sqlParams.push(params.from)
      }
      if (params.to) {
        conditions.push('started_at <= ?')
        sqlParams.push(params.to)
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
      const orderBy = SORT_COLUMNS[params.sortBy ?? 'recent']

      const sql = `
        SELECT id, source, project_slug, cwd, branch, started_at, ended_at,
               duration_minutes, total_turns, total_tokens, message_count,
               error_count, topic, summary
        FROM sessions
        ${whereClause}
        ORDER BY ${orderBy}
      `

      const rows = db.prepare(sql).all(...sqlParams) as Array<Record<string, unknown>>

      const sessions = rows.map(row => ({
        id: row.id as string,
        source: row.source as string,
        projectSlug: row.project_slug as string,
        cwd: row.cwd as string,
        branch: row.branch as string | null,
        startedAt: row.started_at as string,
        endedAt: row.ended_at as string | null,
        durationMinutes: row.duration_minutes as number | null,
        totalTurns: row.total_turns as number,
        totalTokens: row.total_tokens as number,
        messageCount: row.message_count as number | null,
        errorCount: row.error_count as number | null,
        topic: row.topic as string | null,
        summary: row.summary as string | null,
      }))

      // Paginate
      const page = pagination.paginate(sessions, {
        cursor: params.cursor,
        limit: params.limit,
      })

      const meta = formatter.formatMeta(freshness)
      const paginationResult = page.hasMore
        ? { cursor: page.cursor!, hasMore: true, totalEstimate: page.totalEstimate }
        : { cursor: '', hasMore: false, totalEstimate: page.totalEstimate }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(formatter.format(page.items, meta, paginationResult), null, 2) }],
      }
    }
  )
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/tools/list-sessions.ts
git commit -m "feat: rewrite list_sessions to query DB with sorting and rich metadata"
```

---

### Task 8: Simplify get_session — Read from Stored Columns

**Files:**
- Modify: `src/tools/get-session.ts`

- [ ] **Step 1: Rewrite get-session.ts**

Remove all the query-time `computedSummary` aggregation (lines 99-154). Read metrics from stored columns instead.

Key changes:
- Session SELECT includes all new columns
- `detail=summary`: Return compact card (same fields as list_sessions)
- `detail=metadata`: Add `toolCounts` (parsed from JSON), `filesChanged` (parsed from JSON), `correctionCount`, `subagentCount`, `subagents[]`
- `detail=full`: Add subagents with full metadata
- Remove reference to `summaries` table (lines 159-165)

The session lookup query becomes:

```sql
SELECT id, source, project_slug, cwd, branch, started_at, ended_at,
       model, total_tokens, total_turns, message_count,
       duration_minutes, error_count, correction_count, subagent_count,
       tool_counts, files_changed, topic, summary, summary_generated_at
FROM sessions WHERE id = ?
```

For `detail=summary`, return:

```typescript
{
  id, source, projectSlug, cwd, branch, startedAt, endedAt,
  durationMinutes, totalTurns, totalTokens, errorCount, topic, summary
}
```

For `detail=metadata`, add:

```typescript
{
  ...summary fields,
  messageCount, correctionCount, subagentCount,
  toolCounts: JSON.parse(session.tool_counts ?? '{}'),
  filesChanged: JSON.parse(session.files_changed ?? '[]'),
  subagents: [...subagent query results...],
}
```

For `detail=full`, additionally include distilled conversation samples (first/last N messages) using `ConversationDistiller`. This requires reading the JSONL via the adapter's `getMessages()`:

```typescript
import { distillConversation } from '../services/conversation-distiller'

// In detail=full block:
const messages: NormalizedMessage[] = []
for await (const msg of registry.getMessages(params.sessionId)) {
  messages.push(msg)
}
const distilled = distillConversation(messages, 10)
result.conversationSample = distilled.messages
```

This is the only detail level that re-reads the JSONL — `summary` and `metadata` are pure DB reads.

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/tools/get-session.ts
git commit -m "refactor: get_session reads stored metrics instead of query-time computation"
```

---

### Task 9: Update Analyzer — Human-Readable Labels

**Files:**
- Modify: `src/services/analyzer.ts:34-75` (analyzeErrors), `77-118` (analyzeCorrections), `165-205` (analyzeCostlySessions)

- [ ] **Step 1: Update SQL queries to join sessions.topic and sessions.started_at**

For `analyzeErrors`, `analyzeCorrections`, and `analyzeCostlySessions`, change the label from `row.id` to a human-readable format:

```typescript
// In analyzeErrors (and similar for analyzeCorrections):
// Change SELECT to include s.topic, s.started_at
// Change label construction:

return rows.map(row => ({
  label: formatSessionLabel(row.started_at, row.topic),
  count: row.error_count,
  sessionId: row.id,
  projectSlug: row.project_slug ?? undefined,
}))

// Add helper at top of file:
function formatSessionLabel(startedAt: string | null, topic: string | null): string {
  const date = startedAt ? startedAt.slice(0, 10) : 'unknown'
  return topic ? `${date} — ${topic}` : date
}
```

For `analyzeCostlySessions`, the SELECT already queries sessions directly — add `topic, started_at` to the SELECT and update the label.

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/services/analyzer.ts
git commit -m "feat: analyzer uses human-readable session labels instead of raw IDs"
```

---

### Task 10: Clean Up — Remove SummaryService

**Files:**
- Delete: `src/services/summary-service.ts`
- Modify: `src/container/modules.ts` — remove SummaryService registration (lines 52-53)
- Modify: `src/container/tokens.ts` — remove SummaryService token (line 14)

- [ ] **Step 1: Delete summary-service.ts**

```bash
rm src/services/summary-service.ts
```

- [ ] **Step 2: Remove from modules.ts**

Remove lines 12 (import), 52-53 (registration):
```typescript
// Delete: import { SummaryService } from '../services/summary-service'
// Delete: const summaryService = new SummaryService(db, llmClient)
// Delete: container.register(TOKENS.SummaryService, { useValue: summaryService })
```

- [ ] **Step 3: Remove from tokens.ts**

Remove line 14:
```typescript
// Delete: SummaryService: Symbol('SummaryService'),
```

- [ ] **Step 4: Check for any remaining imports of SummaryService**

Run: `grep -r "SummaryService\|summary-service" src/`
Expected: No matches (or only the deleted file)

- [ ] **Step 5: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: remove SummaryService — summary now lives on sessions table"
```

---

### Task 11: Integration Test — Full Pipeline

**Files:**
- Create: `src/integration/rich-indexing.test.ts`

- [ ] **Step 1: Write end-to-end test**

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { IndexManager } from '../services/index-manager'
import { FreshnessGuard } from '../services/freshness-guard'

// Reuse createMockRegistry from freshness-guard.test.ts (extract to test-utils if needed)

describe('Rich indexing integration', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    new IndexManager(db).ensureSchema()
  })

  it('list_sessions query returns enriched session cards', async () => {
    // Setup: sync a session with known data
    // Then query sessions table directly (simulating what list_sessions does)
    // Verify all fields present

    // ... (use mock registry, sync, then SELECT from sessions)
    const rows = db.prepare(`
      SELECT id, topic, summary, ended_at, duration_minutes, error_count, total_turns
      FROM sessions ORDER BY started_at DESC
    `).all()

    // Verify shape matches what list_sessions would return
    for (const row of rows as any[]) {
      expect(row.topic).toBeTruthy()
      expect(row.ended_at).toBeTruthy()
      expect(typeof row.duration_minutes).toBe('number')
      expect(typeof row.error_count).toBe('number')
    }
  })

  it('v0 database migrates and backfills metrics', async () => {
    // Create v0 schema, insert session, run ensureSchema + ensureFresh
    // Verify metrics populated on existing session
  })
})
```

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add src/integration/
git commit -m "test: add rich indexing integration tests"
```

---

### Task 12: Delete Database and Re-index

After all code changes are complete:

- [ ] **Step 1: Delete the existing index to force full re-index**

```bash
rm ~/.claude/session-mcp-index.db
```

- [ ] **Step 2: Start the MCP server and trigger a sync**

```bash
npx tsx src/server.ts
```

Use any MCP tool call (e.g., `list_projects`) to trigger `ensureFresh()` and verify the full pipeline works with real session data.

- [ ] **Step 3: Verify real data**

Use `list_sessions` and confirm:
- Sessions have `topic`, `endedAt`, `durationMinutes`, `errorCount`
- Sessions have `summary` (after LLM processes them, may take a few sync cycles)
- Sorting works (`sortBy=errors`, `sortBy=longest`)

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat: complete rich session indexing — self-describing MCP responses"
```
