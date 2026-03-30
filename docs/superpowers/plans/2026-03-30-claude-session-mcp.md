# Claude Session MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an MCP server that gives LLM agents first-class access to Claude Code session history for autonomous pattern discovery and self-improvement.

**Architecture:** Three DI-managed layers (data client → LLM optimization → MCP tools) in a single process. SQLite FTS5 for indexing, JSONL files as source of truth, local LLM for summarization. Adapter-based data model for future multi-agent support.

**Tech Stack:** TypeScript (ESM, strict), tsx (no transpile), @modelcontextprotocol/sdk, tsyringe + reflect-metadata, better-sqlite3, vitest

**Spec:** `docs/superpowers/specs/2026-03-30-claude-session-mcp-design.md`
**Research:** `docs/research/*.md` — implementation-critical parsing details

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `src/server.ts` (minimal placeholder)

- [ ] **Step 1: Initialize package.json**

```json
{
  "name": "claude-session-mcp",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "tsx --watch src/server.ts",
    "start": "tsx src/server.ts",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "engines": {
    "node": ">=20"
  }
}
```

- [ ] **Step 2: Install dependencies**

Run: `npm install @modelcontextprotocol/sdk tsyringe reflect-metadata better-sqlite3 zod`
Run: `npm install -D typescript tsx vitest @types/better-sqlite3 @types/node`

- [ ] **Step 3: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "resolveJsonModule": true,
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "fixtures"]
}
```

- [ ] **Step 4: Create vitest.config.ts**

```typescript
import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/index.ts'],
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
})
```

- [ ] **Step 5: Create minimal server.ts placeholder**

```typescript
import 'reflect-metadata'

console.error('claude-session-mcp server starting...')
```

- [ ] **Step 6: Verify setup**

Run: `npx tsx src/server.ts`
Expected: prints "claude-session-mcp server starting..." to stderr

Run: `npx vitest run`
Expected: "No test files found" (no tests yet, but vitest runs)

- [ ] **Step 7: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts src/server.ts package-lock.json
git commit -m "feat: scaffold project with tsx, tsyringe, vitest, mcp sdk"
```

---

### Task 2: Shared Types

**Files:**
- Create: `src/types/common.ts`
- Create: `src/types/session.ts`
- Create: `src/types/project.ts`
- Create: `src/types/adapter.ts`
- Create: `src/types/tools.ts`
- Create: `src/types/llm.ts`
- Create: `src/types/index.ts`

These are pure type definitions — no runtime code, no tests needed. They define the contracts between all layers.

- [ ] **Step 1: Create common.ts — shared primitives**

```typescript
export interface DateRange {
  readonly from?: string  // ISO 8601
  readonly to?: string    // ISO 8601
}

export interface PaginationParams {
  readonly cursor?: string
  readonly limit?: number
}

export interface PaginationResult {
  readonly cursor: string
  readonly hasMore: boolean
  readonly totalEstimate: number
}

export interface ResponseMeta {
  readonly indexedAt: string
  readonly sessionCount: number
  readonly staleSessions: number
  readonly syncDurationMs: number
}

export interface ToolResponse<T> {
  readonly data: T
  readonly pagination?: PaginationResult
  readonly meta: ResponseMeta
}
```

- [ ] **Step 2: Create session.ts — session and message types**

Key parsing details from research:
- `message.content` is string for user text, array for tool results and assistant messages
- `toolUseResult` can be string OR object — use `unknown` and narrow
- `stop_reason` is null on intermediate chunks
- Timestamps: JSONL uses ISO 8601 strings, sessions/*.json uses Unix ms

```typescript
export type MessageRole = 'user' | 'assistant' | 'system'
export type MessageType = 'user' | 'assistant' | 'system' | 'progress' | 'file-history-snapshot' | 'queue-operation'

export interface ContentBlock {
  readonly type: 'text' | 'tool_use' | 'tool_result' | 'thinking'
  readonly text?: string
  readonly id?: string          // tool_use ID
  readonly name?: string        // tool name
  readonly input?: unknown      // tool input
  readonly tool_use_id?: string // tool_result ref
  readonly content?: unknown    // tool_result content (string or array)
  readonly thinking?: string    // always empty in storage
  readonly signature?: string
}

export interface TokenUsage {
  readonly input_tokens: number
  readonly output_tokens: number
  readonly cache_creation_input_tokens?: number
  readonly cache_read_input_tokens?: number
}

// Normalized turn — reconstructed from multiple JSONL lines
export interface NormalizedMessage {
  readonly id: string
  readonly sessionId: string
  readonly role: MessageRole
  readonly timestamp: string         // ISO 8601
  readonly contentBlocks: readonly ContentBlock[]
  readonly model?: string
  readonly tokenUsage?: TokenUsage
  readonly toolNames?: readonly string[]
  readonly isError: boolean
  readonly isCorrection: boolean     // user message following assistant that changes direction
  readonly requestId?: string
  readonly parentUuid?: string | null
  readonly uuid: string
}

export interface SessionMeta {
  readonly id: string
  readonly source: string            // "claude-code", "openhands", etc.
  readonly projectSlug: string
  readonly cwd: string
  readonly branch?: string
  readonly startedAt: string         // ISO 8601
  readonly model?: string
  readonly totalTokens?: number
  readonly totalTurns?: number
  readonly summaryText?: string
  readonly version?: string
}

export interface SubagentMeta {
  readonly id: string
  readonly sessionId: string         // parent session ID
  readonly agentType?: string        // "Explore", "general-purpose", etc.
  readonly description?: string
  readonly totalTokens?: number
  readonly totalTools?: number
  readonly durationMs?: number
  readonly model?: string
}

export interface FileChange {
  readonly sessionId: string
  readonly messageId?: string
  readonly filePath: string
  readonly operation: 'read' | 'write' | 'edit' | 'create'
  readonly timestamp: string
}
```

- [ ] **Step 3: Create project.ts — project and config types**

```typescript
import type { SessionMeta } from './session'

export interface ProjectMeta {
  readonly slug: string
  readonly path: string              // absolute path derived from slug
  readonly source: string
  readonly sessionCount: number
  readonly lastActive?: string       // ISO 8601
  readonly branches?: readonly string[]
  readonly hasMemory: boolean
  readonly hasClaudeMd: boolean
}

export interface ProjectDetail extends ProjectMeta {
  readonly claudeMd?: string
  readonly settings?: ProjectSettings
  readonly stats?: ProjectStats
}

export interface ProjectSettings {
  readonly model?: string
  readonly permissions?: Record<string, unknown>
  readonly hooks?: Record<string, unknown>
}

export interface ProjectStats {
  readonly totalTokensByModel?: Record<string, number>
  readonly totalSessions?: number
  readonly dailyActivity?: Record<string, number>
}

export interface MemoryEntry {
  readonly projectSlug: string
  readonly fileName: string
  readonly name: string
  readonly description: string
  readonly type: 'user' | 'feedback' | 'project' | 'reference'
  readonly content: string
}
```

- [ ] **Step 4: Create adapter.ts — adapter interface and freshness types**

```typescript
import type { ProjectMeta } from './project'
import type { SessionMeta, NormalizedMessage, FileChange, SubagentMeta } from './session'
import type { MemoryEntry } from './project'

export interface IndexState {
  readonly sessionOffsets: ReadonlyMap<string, number>  // sessionId -> byte offset
  readonly lastSyncAt: string
}

export interface FreshnessResult {
  readonly isStale: boolean
  readonly newSessions: readonly string[]
  readonly changedSessions: readonly string[]
  readonly removedSessions: readonly string[]
}

export interface SessionAdapter {
  readonly source: string

  discoverProjects(): AsyncIterable<ProjectMeta>
  discoverSessions(project?: string): AsyncIterable<SessionMeta>
  getMessages(sessionId: string): AsyncIterable<NormalizedMessage>
  getFileChanges(sessionId: string): AsyncIterable<FileChange>
  getSubagents(sessionId: string): AsyncIterable<SubagentMeta>
  getMemory(project?: string): AsyncIterable<MemoryEntry>
  resolveProject(path: string): ProjectMeta | undefined
  checkFreshness(known: IndexState): Promise<FreshnessResult>
}
```

- [ ] **Step 5: Create tools.ts — tool parameter and response types**

```typescript
import type { DateRange, PaginationParams } from './common'

// analyze metric types
export type AnalyzeMetric = 'errors' | 'corrections' | 'tool_failures' | 'costly_sessions' | 'frequent_files'

// get_conversation window types
export type ConversationWindow = 'start' | 'end' | 'errors' | 'corrections'

// Project resolution — every tool that accepts project also accepts path
export interface ProjectFilter {
  readonly project?: string
  readonly path?: string
}

export interface ListProjectsParams {
  readonly sortBy?: 'recent' | 'sessions' | 'name'
  readonly limit?: number
}

export interface GetProjectParams extends ProjectFilter {
  readonly detail?: 'summary' | 'full'
}

export interface ListSessionsParams extends ProjectFilter, PaginationParams {
  readonly branch?: string
  readonly dateRange?: DateRange
}

export interface GetSessionParams {
  readonly sessionId: string
  readonly detail?: 'summary' | 'metadata' | 'full'
}

export interface GetConversationParams extends PaginationParams {
  readonly sessionId: string
  readonly maxTokens?: number
  readonly roles?: readonly MessageRole[]
  readonly includeToolResults?: boolean
  readonly window?: ConversationWindow
}

export interface SearchParams extends ProjectFilter, PaginationParams {
  readonly query: string
  readonly dateRange?: DateRange
  readonly sessionId?: string
  readonly maxResults?: number
}

export interface GetChangesParams extends ProjectFilter, PaginationParams {
  readonly sessionId?: string
  readonly filePath?: string
  readonly operation?: string
}

export interface GetMemoryParams extends ProjectFilter {
  readonly type?: 'user' | 'feedback' | 'project' | 'reference'
  readonly search?: string
}

export interface AnalyzeParams extends ProjectFilter {
  readonly metric: AnalyzeMetric
  readonly dateRange?: DateRange
  readonly limit?: number
}

// Import MessageRole for GetConversationParams
import type { MessageRole } from './session'
```

- [ ] **Step 6: Create llm.ts — local LLM client types**

```typescript
export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant'
  readonly content: string
}

export interface ChatCompletionRequest {
  readonly model: string
  readonly messages: readonly ChatMessage[]
  readonly max_tokens?: number
  readonly temperature?: number
}

export interface ChatCompletionResponse {
  readonly id: string
  readonly choices: readonly {
    readonly message: {
      readonly role: string
      readonly content: string
    }
    readonly finish_reason: string
  }[]
  readonly usage: {
    readonly prompt_tokens: number
    readonly completion_tokens: number
    readonly total_tokens: number
  }
}
```

- [ ] **Step 7: Create index.ts barrel export**

```typescript
export * from './common'
export * from './session'
export * from './project'
export * from './adapter'
export * from './tools'
export * from './llm'
```

- [ ] **Step 8: Verify types compile**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 9: Commit**

```bash
git add src/types/
git commit -m "feat: add shared type definitions for all layers"
```

---

### Task 3: DI Container and Infrastructure

**Files:**
- Create: `src/container/tokens.ts`
- Create: `src/container/modules.ts`
- Create: `src/container/index.ts`
- Create: `src/infrastructure/database.ts`
- Create: `src/infrastructure/database.test.ts`
- Create: `src/infrastructure/file-system.ts`
- Create: `src/infrastructure/http-client.ts`
- Create: `src/infrastructure/index.ts`

- [ ] **Step 1: Create DI tokens**

```typescript
// src/container/tokens.ts
export const TOKENS = {
  ClaudeDataDir: Symbol('ClaudeDataDir'),
  Database: Symbol('Database'),
  HttpClient: Symbol('HttpClient'),
  LocalLlmUrl: Symbol('LocalLlmUrl'),
  LocalLlmModel: Symbol('LocalLlmModel'),
  SessionAdapter: Symbol('SessionAdapter'),
  AdapterRegistry: Symbol('AdapterRegistry'),
  IndexManager: Symbol('IndexManager'),
  SearchIndex: Symbol('SearchIndex'),
  FreshnessGuard: Symbol('FreshnessGuard'),
  TokenBudgetManager: Symbol('TokenBudgetManager'),
  PaginationManager: Symbol('PaginationManager'),
  SummaryService: Symbol('SummaryService'),
  LocalLlmClient: Symbol('LocalLlmClient'),
  ProjectResolver: Symbol('ProjectResolver'),
  Analyzer: Symbol('Analyzer'),
  ResponseFormatter: Symbol('ResponseFormatter'),
} as const
```

- [ ] **Step 2: Create database.ts — SQLite wrapper**

Must configure: WAL mode, foreign keys, FTS5. Use `better-sqlite3` synchronous API.

```typescript
// src/infrastructure/database.ts
import { injectable, inject } from 'tsyringe'
import Database from 'better-sqlite3'
import { TOKENS } from '../container/tokens'

@injectable()
export class DatabaseConnection {
  private db: Database.Database | null = null

  constructor(
    @inject(TOKENS.ClaudeDataDir) private readonly claudeDir: string
  ) {}

  get(): Database.Database {
    if (!this.db) {
      this.db = new Database(`${this.claudeDir}/session-mcp-index.db`)
      this.db.pragma('journal_mode = WAL')
      this.db.pragma('foreign_keys = ON')
      this.db.pragma('synchronous = NORMAL')
    }
    return this.db
  }

  close(): void {
    this.db?.close()
    this.db = null
  }
}
```

- [ ] **Step 3: Write database test**

```typescript
// src/infrastructure/database.test.ts
import { describe, it, expect, afterEach } from 'vitest'
import { DatabaseConnection } from './database'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('DatabaseConnection', () => {
  let tempDir: string
  let db: DatabaseConnection

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'session-mcp-test-'))
    // Manually construct — no DI in unit tests
    db = new (DatabaseConnection as any)()
    ;(db as any).claudeDir = tempDir
  })

  afterEach(() => {
    db.close()
    rmSync(tempDir, { recursive: true })
  })

  it('creates database with WAL mode', () => {
    const conn = db.get()
    const mode = conn.pragma('journal_mode', { simple: true })
    expect(mode).toBe('wal')
  })

  it('returns same connection on subsequent calls', () => {
    expect(db.get()).toBe(db.get())
  })

  it('creates new connection after close', () => {
    const first = db.get()
    db.close()
    const second = db.get()
    expect(second).not.toBe(first)
  })
})
```

- [ ] **Step 4: Run test**

Run: `npx vitest run src/infrastructure/database.test.ts`
Expected: 3 tests pass

- [ ] **Step 5: Create file-system.ts — async helpers**

```typescript
// src/infrastructure/file-system.ts
import { stat, readFile, readdir } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

export async function fileSize(path: string): Promise<number> {
  const s = await stat(path)
  return s.size
}

export async function fileMtime(path: string): Promise<number> {
  const s = await stat(path)
  return s.mtimeMs
}

export async function readJsonFile<T>(path: string): Promise<T> {
  const content = await readFile(path, 'utf-8')
  return JSON.parse(content) as T
}

export async function readTextFile(path: string): Promise<string> {
  return readFile(path, 'utf-8')
}

export async function listDirectories(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true })
  return entries.filter(e => e.isDirectory()).map(e => e.name)
}

export async function listFiles(path: string, extension?: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true })
  return entries
    .filter(e => e.isFile() && (!extension || e.name.endsWith(extension)))
    .map(e => e.name)
}

// Stream JSONL lines starting from byte offset — critical for incremental indexing
export async function* streamJsonlLines(
  path: string,
  startOffset: number = 0
): AsyncIterable<{ line: string; offset: number }> {
  const stream = createReadStream(path, {
    start: startOffset,
    encoding: 'utf-8',
  })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  let offset = startOffset
  for await (const line of rl) {
    if (line.trim()) {
      yield { line, offset }
    }
    offset += Buffer.byteLength(line, 'utf-8') + 1 // +1 for newline
  }
}
```

- [ ] **Step 6: Create http-client.ts — base HTTP for local LLM**

```typescript
// src/infrastructure/http-client.ts
export interface HttpResponse<T> {
  readonly status: number
  readonly data: T
}

export async function httpPost<TReq, TRes>(
  url: string,
  body: TReq,
  timeoutMs: number = 30_000
): Promise<HttpResponse<TRes>> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    const data = await response.json() as TRes
    return { status: response.status, data }
  } finally {
    clearTimeout(timer)
  }
}
```

- [ ] **Step 7: Create infrastructure/index.ts barrel**

```typescript
export { DatabaseConnection } from './database'
export * from './file-system'
export * from './http-client'
```

- [ ] **Step 8: Create container/modules.ts and container/index.ts**

```typescript
// src/container/modules.ts
import { container } from 'tsyringe'
import { TOKENS } from './tokens'
import { DatabaseConnection } from '../infrastructure/database'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function registerInfrastructure(): void {
  const claudeDir = join(homedir(), '.claude')

  container.register(TOKENS.ClaudeDataDir, { useValue: claudeDir })
  container.register(TOKENS.LocalLlmUrl, { useValue: 'http://10.1.10.20:30000/v1' })
  container.register(TOKENS.LocalLlmModel, { useValue: 'QuantTrio/MiniMax-M2.5-AWQ' })
  container.registerSingleton(TOKENS.Database, DatabaseConnection)
}

// Called after all adapters/services are registered
export function registerAll(): void {
  registerInfrastructure()
  // Adapter registration will be added in Task 5
  // Service registration will be added in Task 7
}
```

```typescript
// src/container/index.ts
export { TOKENS } from './tokens'
export { registerAll } from './modules'
```

- [ ] **Step 9: Commit**

```bash
git add src/container/ src/infrastructure/
git commit -m "feat: add DI container, SQLite infrastructure, file system helpers"
```

---

### Task 4: SQLite Schema and Index Manager

**Files:**
- Create: `src/services/index-manager.ts`
- Create: `src/services/index-manager.test.ts`

- [ ] **Step 1: Write failing test for schema creation**

```typescript
// src/services/index-manager.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { IndexManager } from './index-manager'

describe('IndexManager', () => {
  let tempDir: string
  let db: Database.Database
  let manager: IndexManager

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'idx-test-'))
    db = new Database(join(tempDir, 'test.db'))
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    manager = new IndexManager(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tempDir, { recursive: true })
  })

  it('creates all tables on ensureSchema', () => {
    manager.ensureSchema()
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as { name: string }[]
    const names = tables.map(t => t.name)

    expect(names).toContain('sessions')
    expect(names).toContain('messages')
    expect(names).toContain('file_changes')
    expect(names).toContain('subagents')
    expect(names).toContain('memory_entries')
    expect(names).toContain('summaries')
  })

  it('creates FTS5 virtual table', () => {
    manager.ensureSchema()
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='messages_fts'"
    ).all()
    expect(tables).toHaveLength(1)
  })

  it('is idempotent — calling twice does not error', () => {
    manager.ensureSchema()
    expect(() => manager.ensureSchema()).not.toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/index-manager.test.ts`
Expected: FAIL — IndexManager not found

- [ ] **Step 3: Implement IndexManager**

```typescript
// src/services/index-manager.ts
import { injectable, inject } from 'tsyringe'
import type Database from 'better-sqlite3'
import { TOKENS } from '../container/tokens'
import { DatabaseConnection } from '../infrastructure/database'

@injectable()
export class IndexManager {
  private readonly db: Database.Database

  constructor(dbOrConnection: Database.Database | DatabaseConnection) {
    // Support both direct Database (testing) and DI-injected DatabaseConnection
    if ('get' in dbOrConnection) {
      this.db = (dbOrConnection as DatabaseConnection).get()
    } else {
      this.db = dbOrConnection as Database.Database
    }
  }

  ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        project_slug TEXT NOT NULL,
        cwd TEXT NOT NULL,
        branch TEXT,
        started_at TEXT NOT NULL,
        model TEXT,
        total_tokens INTEGER,
        total_turns INTEGER,
        summary_text TEXT,
        byte_offset INTEGER NOT NULL DEFAULT 0,
        version TEXT,
        indexed_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_slug);
      CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at);

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        role TEXT NOT NULL,
        type TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        model TEXT,
        token_count INTEGER,
        has_tool_use INTEGER NOT NULL DEFAULT 0,
        tool_names TEXT,
        is_error INTEGER NOT NULL DEFAULT 0,
        is_correction INTEGER NOT NULL DEFAULT 0,
        content_preview TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
      CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
      CREATE INDEX IF NOT EXISTS idx_messages_errors ON messages(is_error) WHERE is_error = 1;
      CREATE INDEX IF NOT EXISTS idx_messages_corrections ON messages(is_correction) WHERE is_correction = 1;

      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content_preview,
        content='messages',
        content_rowid='rowid'
      );

      CREATE TABLE IF NOT EXISTS file_changes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        message_id TEXT,
        file_path TEXT NOT NULL,
        operation TEXT NOT NULL,
        timestamp TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_file_changes_session ON file_changes(session_id);
      CREATE INDEX IF NOT EXISTS idx_file_changes_path ON file_changes(file_path);

      CREATE TABLE IF NOT EXISTS subagents (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        agent_type TEXT,
        description TEXT,
        total_tokens INTEGER,
        total_tools INTEGER,
        duration_ms INTEGER,
        model TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_subagents_session ON subagents(session_id);

      CREATE TABLE IF NOT EXISTS memory_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_slug TEXT NOT NULL,
        file_name TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        UNIQUE(project_slug, file_name)
      );

      CREATE INDEX IF NOT EXISTS idx_memory_project ON memory_entries(project_slug);
      CREATE INDEX IF NOT EXISTS idx_memory_type ON memory_entries(type);

      CREATE TABLE IF NOT EXISTS summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        summary_text TEXT NOT NULL,
        generated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(entity_type, entity_id)
      );
    `)
  }

  getSessionOffset(sessionId: string): number {
    const row = this.db.prepare(
      'SELECT byte_offset FROM sessions WHERE id = ?'
    ).get(sessionId) as { byte_offset: number } | undefined
    return row?.byte_offset ?? 0
  }

  updateSessionOffset(sessionId: string, offset: number): void {
    this.db.prepare(
      'UPDATE sessions SET byte_offset = ? WHERE id = ?'
    ).run(offset, sessionId)
  }

  getKnownSessionIds(): Set<string> {
    const rows = this.db.prepare('SELECT id FROM sessions').all() as { id: string }[]
    return new Set(rows.map(r => r.id))
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/services/index-manager.test.ts`
Expected: 3 tests pass

- [ ] **Step 5: Add tests for offset tracking**

```typescript
  it('tracks session byte offsets', () => {
    manager.ensureSchema()
    db.prepare(
      "INSERT INTO sessions (id, source, project_slug, cwd, started_at, byte_offset) VALUES (?, ?, ?, ?, ?, ?)"
    ).run('sess-1', 'claude-code', '-home-test', '/home/test', '2026-03-30T00:00:00Z', 0)

    expect(manager.getSessionOffset('sess-1')).toBe(0)

    manager.updateSessionOffset('sess-1', 5000)
    expect(manager.getSessionOffset('sess-1')).toBe(5000)
  })

  it('returns 0 for unknown session offset', () => {
    manager.ensureSchema()
    expect(manager.getSessionOffset('nonexistent')).toBe(0)
  })
```

- [ ] **Step 6: Run all tests**

Run: `npx vitest run src/services/index-manager.test.ts`
Expected: 5 tests pass

- [ ] **Step 7: Commit**

```bash
git add src/services/index-manager.ts src/services/index-manager.test.ts
git commit -m "feat: add IndexManager with SQLite schema and FTS5"
```

---

### Task 5: Claude Code Adapter — Session Discovery

**Files:**
- Create: `src/adapters/claude-code/session-discovery.ts`
- Create: `src/adapters/claude-code/session-discovery.test.ts`
- Create: `fixtures/` directory with test data

This is the foundation — discovers projects and sessions from `~/.claude/`.

- [ ] **Step 1: Create test fixtures**

Create a minimal fixture directory structure that mimics `~/.claude/`:

```
fixtures/claude-home/
  projects/
    -home-test-project-alpha/
      sessions-index.json
      aaaaaaaa-1111-2222-3333-444444444444.jsonl
      memory/
        MEMORY.md
        feedback_testing.md
    -home-test-project-beta/
      bbbbbbbb-1111-2222-3333-444444444444.jsonl
  sessions/
    12345.json
  settings.json
  settings.local.json
  history.jsonl
```

Write fixture `sessions-index.json`:
```json
{
  "version": 1,
  "entries": [
    {
      "sessionId": "aaaaaaaa-1111-2222-3333-444444444444",
      "firstPrompt": "Build the auth module",
      "created": "2026-03-28T10:00:00Z",
      "modified": "2026-03-28T12:00:00Z",
      "fileMtime": 1774900800000,
      "gitBranch": "feat/auth"
    }
  ]
}
```

Write fixture session JSONL (3-4 lines covering user text, assistant text, tool_use):
```jsonl
{"type":"file-history-snapshot","messageId":"msg-1","snapshot":{"messageId":"msg-1","trackedFileBackups":{},"timestamp":"2026-03-28T10:00:00Z"},"isSnapshotUpdate":false}
{"parentUuid":null,"isSidechain":false,"promptId":"prompt-1","type":"user","message":{"role":"user","content":"Build the auth module"},"uuid":"msg-1","timestamp":"2026-03-28T10:00:01Z","permissionMode":"bypassPermissions","userType":"external","entrypoint":"cli","cwd":"/home/test/project-alpha","sessionId":"aaaaaaaa-1111-2222-3333-444444444444","version":"2.1.87","gitBranch":"feat/auth"}
{"parentUuid":"msg-1","isSidechain":false,"message":{"model":"claude-opus-4-6","id":"resp-1","type":"message","role":"assistant","content":[{"type":"text","text":"I'll build the auth module."}],"stop_reason":"end_turn","stop_sequence":null,"usage":{"input_tokens":100,"output_tokens":50}},"requestId":"req-1","type":"assistant","uuid":"msg-2","timestamp":"2026-03-28T10:00:05Z","userType":"external","entrypoint":"cli","cwd":"/home/test/project-alpha","sessionId":"aaaaaaaa-1111-2222-3333-444444444444","version":"2.1.87","gitBranch":"feat/auth"}
```

Write fixture `sessions/12345.json`:
```json
{"pid":12345,"sessionId":"aaaaaaaa-1111-2222-3333-444444444444","cwd":"/home/test/project-alpha","startedAt":1774897200000,"kind":"interactive","entrypoint":"cli"}
```

Write fixture memory files, settings.json, history.jsonl with minimal valid content.

- [ ] **Step 2: Write failing test for session discovery**

```typescript
// src/adapters/claude-code/session-discovery.test.ts
import { describe, it, expect } from 'vitest'
import { SessionDiscovery } from './session-discovery'
import { join } from 'node:path'

const FIXTURES = join(__dirname, '../../../fixtures/claude-home')

describe('SessionDiscovery', () => {
  const discovery = new SessionDiscovery(FIXTURES)

  it('discovers all projects', async () => {
    const projects: any[] = []
    for await (const p of discovery.discoverProjects()) {
      projects.push(p)
    }
    expect(projects).toHaveLength(2)
    expect(projects.map(p => p.slug).sort()).toEqual([
      '-home-test-project-alpha',
      '-home-test-project-beta',
    ])
  })

  it('derives path from slug', async () => {
    const projects: any[] = []
    for await (const p of discovery.discoverProjects()) {
      projects.push(p)
    }
    const alpha = projects.find(p => p.slug === '-home-test-project-alpha')
    expect(alpha.path).toBe('/home/test/project-alpha')
  })

  it('discovers sessions for a project', async () => {
    const sessions: any[] = []
    for await (const s of discovery.discoverSessions('-home-test-project-alpha')) {
      sessions.push(s)
    }
    expect(sessions).toHaveLength(1)
    expect(sessions[0].id).toBe('aaaaaaaa-1111-2222-3333-444444444444')
    expect(sessions[0].branch).toBe('feat/auth')
  })

  it('discovers sessions across all projects when no filter', async () => {
    const sessions: any[] = []
    for await (const s of discovery.discoverSessions()) {
      sessions.push(s)
    }
    expect(sessions.length).toBeGreaterThanOrEqual(2)
  })

  it('resolves project from path after cache built', async () => {
    await discovery.buildProjectCache()
    const project = discovery.resolveProject('/home/test/project-alpha/src/auth')
    expect(project).toBeDefined()
    expect(project!.slug).toBe('-home-test-project-alpha')
  })

  it('returns undefined for unknown path after cache built', async () => {
    await discovery.buildProjectCache()
    expect(discovery.resolveProject('/unknown/path')).toBeUndefined()
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/adapters/claude-code/session-discovery.test.ts`
Expected: FAIL — SessionDiscovery not found

- [ ] **Step 4: Implement SessionDiscovery**

Key implementation details:
- Project slug derivation: replace `/` with `-` (produces leading `-`)
- Reverse: replace leading `-` then all `-` back to `/`... NO — this is lossy. Instead, scan `projects/` directory for slug names and derive paths by stripping leading `-` and replacing `-` with `/`. BUT hyphens in directory names make this ambiguous.
- Better approach: read `cwd` from session JSONL or `sessions-index.json` entries to get the real path. Fall back to slug-based heuristic.
- `sessions-index.json` may not exist — fall back to listing `.jsonl` files
- UUID regex for session file detection: `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/`

```typescript
// src/adapters/claude-code/session-discovery.ts
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProjectMeta, SessionMeta } from '../../types'
import { readJsonFile, fileExists, listFiles } from '../../infrastructure/file-system'

const UUID_JSONL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/

interface SessionsIndex {
  readonly version: number
  readonly entries: readonly SessionsIndexEntry[]
}

interface SessionsIndexEntry {
  readonly sessionId: string
  readonly firstPrompt?: string
  readonly created?: string
  readonly modified?: string
  readonly fileMtime?: number
  readonly gitBranch?: string
}

export class SessionDiscovery {
  private projectCache: Map<string, ProjectMeta> | null = null

  constructor(private readonly claudeDir: string) {}

  async *discoverProjects(): AsyncIterable<ProjectMeta> {
    const projectsDir = join(this.claudeDir, 'projects')
    if (!(await fileExists(projectsDir))) return

    const entries = await readdir(projectsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const slug = entry.name
      const projectDir = join(projectsDir, slug)
      const memoryDir = join(projectDir, 'memory')
      // Derive path: strip leading dash, replace remaining dashes with /
      // This is a heuristic — we'll refine with cwd from session data
      const path = '/' + slug.replace(/^-/, '').replace(/-/g, '/')

      const hasMemory = await fileExists(memoryDir)
      const claudeMdPath = join(path, 'CLAUDE.md')
      const hasClaudeMd = await fileExists(claudeMdPath)

      // Count sessions
      const jsonlFiles = (await listFiles(projectDir, '.jsonl')).filter(
        f => UUID_JSONL.test(f)
      )

      const meta: ProjectMeta = {
        slug,
        path,
        source: 'claude-code',
        sessionCount: jsonlFiles.length,
        hasMemory,
        hasClaudeMd,
      }

      yield meta
    }
  }

  async *discoverSessions(project?: string): AsyncIterable<SessionMeta> {
    const projectsDir = join(this.claudeDir, 'projects')
    if (!(await fileExists(projectsDir))) return

    const entries = await readdir(projectsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (project && entry.name !== project) continue

      const slug = entry.name
      const projectDir = join(projectsDir, slug)
      const indexPath = join(projectDir, 'sessions-index.json')

      // Try sessions-index.json first
      if (await fileExists(indexPath)) {
        const index = await readJsonFile<SessionsIndex>(indexPath)
        for (const e of index.entries) {
          yield {
            id: e.sessionId,
            source: 'claude-code',
            projectSlug: slug,
            cwd: '/' + slug.replace(/^-/, '').replace(/-/g, '/'),
            branch: e.gitBranch,
            startedAt: e.created ?? new Date(e.fileMtime ?? 0).toISOString(),
            summaryText: e.firstPrompt,
          }
        }
      } else {
        // Fall back to listing JSONL files
        const files = (await listFiles(projectDir, '.jsonl')).filter(
          f => UUID_JSONL.test(f)
        )
        for (const f of files) {
          const sessionId = f.replace('.jsonl', '')
          const fileStat = await stat(join(projectDir, f))
          yield {
            id: sessionId,
            source: 'claude-code',
            projectSlug: slug,
            cwd: '/' + slug.replace(/^-/, '').replace(/-/g, '/'),
            startedAt: fileStat.birthtime.toISOString(),
          }
        }
      }
    }
  }

  resolveProject(path: string): ProjectMeta | undefined {
    // Walk up the directory tree, try to match a project slug
    let current = path
    while (current !== '/') {
      const slug = '-' + current.slice(1).replace(/\//g, '-')
      // We need the project cache — build it synchronously is not ideal
      // For now, check if the directory exists
      // This will be improved when integrated with the adapter registry
      if (this.projectCache?.has(slug)) {
        return this.projectCache.get(slug)
      }
      const parent = current.substring(0, current.lastIndexOf('/')) || '/'
      if (parent === current) break
      current = parent
    }
    return undefined
  }

  // Called after discoverProjects to populate cache for resolveProject
  async buildProjectCache(): Promise<void> {
    this.projectCache = new Map()
    for await (const p of this.discoverProjects()) {
      this.projectCache.set(p.slug, p)
    }
  }
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/adapters/claude-code/session-discovery.test.ts`
Expected: all tests pass

- [ ] **Step 6: Commit**

```bash
git add src/adapters/claude-code/session-discovery.ts src/adapters/claude-code/session-discovery.test.ts fixtures/
git commit -m "feat: add Claude Code session discovery with project resolution"
```

---

### Task 6: Claude Code Adapter — Conversation Parser

**Files:**
- Create: `src/adapters/claude-code/conversation-parser.ts`
- Create: `src/adapters/claude-code/conversation-parser.test.ts`

The most complex parser — must reconstruct complete turns from per-content-block JSONL lines.

- [ ] **Step 1: Write failing tests**

Test cases must cover:
- Grouping multiple content blocks by `requestId` into one NormalizedMessage
- Handling `stop_reason: null` intermediate blocks
- User text messages (content is string)
- User tool result messages (content is array)
- `queue-operation` lines (no uuid/parentUuid — must not crash)
- `file-history-snapshot` lines (different structure)
- Error detection in tool results
- Correction detection (user message after assistant that changes approach)

```typescript
// src/adapters/claude-code/conversation-parser.test.ts
import { describe, it, expect } from 'vitest'
import { ConversationParser } from './conversation-parser'
import { join } from 'node:path'

const FIXTURES = join(__dirname, '../../../fixtures/claude-home')

describe('ConversationParser', () => {
  const parser = new ConversationParser()

  it('parses user text message', async () => {
    const messages = []
    const sessionPath = join(
      FIXTURES,
      'projects/-home-test-project-alpha/aaaaaaaa-1111-2222-3333-444444444444.jsonl'
    )
    for await (const msg of parser.parseSession(sessionPath)) {
      messages.push(msg)
    }
    const userMsg = messages.find(m => m.role === 'user')
    expect(userMsg).toBeDefined()
    expect(userMsg!.contentBlocks[0].type).toBe('text')
  })

  it('groups assistant content blocks by requestId', async () => {
    const messages = []
    const sessionPath = join(
      FIXTURES,
      'projects/-home-test-project-alpha/aaaaaaaa-1111-2222-3333-444444444444.jsonl'
    )
    for await (const msg of parser.parseSession(sessionPath)) {
      messages.push(msg)
    }
    const assistantMsgs = messages.filter(m => m.role === 'assistant')
    // Each assistant turn should appear once, even if multiple content blocks
    expect(assistantMsgs.length).toBeGreaterThanOrEqual(1)
    expect(assistantMsgs[0].contentBlocks.length).toBeGreaterThanOrEqual(1)
  })

  it('skips file-history-snapshot and queue-operation lines without crashing', async () => {
    const messages = []
    const sessionPath = join(
      FIXTURES,
      'projects/-home-test-project-alpha/aaaaaaaa-1111-2222-3333-444444444444.jsonl'
    )
    for await (const msg of parser.parseSession(sessionPath)) {
      messages.push(msg)
    }
    // Should only contain user and assistant messages
    for (const msg of messages) {
      expect(['user', 'assistant', 'system']).toContain(msg.role)
    }
  })

  it('supports streaming from byte offset', async () => {
    const sessionPath = join(
      FIXTURES,
      'projects/-home-test-project-alpha/aaaaaaaa-1111-2222-3333-444444444444.jsonl'
    )
    // Parse full first
    const all = []
    for await (const msg of parser.parseSession(sessionPath)) {
      all.push(msg)
    }
    // Parse from offset should return fewer or equal messages
    const partial = []
    for await (const msg of parser.parseSession(sessionPath, 100)) {
      partial.push(msg)
    }
    expect(partial.length).toBeLessThanOrEqual(all.length)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/adapters/claude-code/conversation-parser.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement ConversationParser**

Critical implementation details:
- `type: "assistant"` lines: `message.content` is array with exactly ONE element per line
- Group by `requestId` — collect all content blocks until `stop_reason !== null`
- `type: "user"` with `message.content` as string → user text input
- `type: "user"` with `message.content` as array → tool results
- `type: "file-history-snapshot"` and `type: "queue-operation"` → skip (not conversation messages)
- `type: "progress"` → skip
- `type: "system"` → include as system message
- `toolUseResult` can be string OR object — detect errors from either
- Content preview for indexing: first 200 chars of text content

```typescript
// src/adapters/claude-code/conversation-parser.ts
import type { NormalizedMessage, ContentBlock, TokenUsage } from '../../types'
import { streamJsonlLines } from '../../infrastructure/file-system'

interface RawLine {
  readonly type: string
  readonly message?: {
    readonly role: string
    readonly id?: string
    readonly content: unknown
    readonly model?: string
    readonly usage?: Record<string, unknown>
    readonly stop_reason?: string | null
  }
  readonly uuid?: string
  readonly parentUuid?: string | null
  readonly requestId?: string
  readonly timestamp?: string
  readonly sessionId?: string
  readonly toolUseResult?: unknown
}

export class ConversationParser {
  async *parseSession(
    sessionPath: string,
    startOffset: number = 0
  ): AsyncIterable<NormalizedMessage> {
    // Buffer assistant blocks to group by requestId
    const pendingAssistant = new Map<string, {
      blocks: ContentBlock[]
      uuid: string
      parentUuid: string | null | undefined
      timestamp: string
      model?: string
      usage?: TokenUsage
      sessionId?: string
      requestId: string
    }>()

    for await (const { line } of streamJsonlLines(sessionPath, startOffset)) {
      let parsed: RawLine
      try {
        parsed = JSON.parse(line)
      } catch {
        continue // skip malformed lines
      }

      // Skip non-conversation types
      if (
        parsed.type === 'file-history-snapshot' ||
        parsed.type === 'queue-operation' ||
        parsed.type === 'progress'
      ) {
        continue
      }

      if (!parsed.message) continue

      const { message } = parsed

      if (parsed.type === 'assistant' && parsed.requestId) {
        const block = Array.isArray(message.content)
          ? (message.content[0] as ContentBlock)
          : undefined

        if (!block) continue

        const key = parsed.requestId
        if (!pendingAssistant.has(key)) {
          pendingAssistant.set(key, {
            blocks: [],
            uuid: parsed.uuid ?? key,
            parentUuid: parsed.parentUuid,
            timestamp: parsed.timestamp ?? '',
            model: message.model,
            sessionId: parsed.sessionId,
            requestId: key,
          })
        }

        const pending = pendingAssistant.get(key)!
        pending.blocks.push(block)

        // Final block — emit the complete turn
        if (message.stop_reason !== null && message.stop_reason !== undefined) {
          const usage = message.usage as Record<string, number> | undefined
          const tokenUsage: TokenUsage | undefined = usage ? {
            input_tokens: usage.input_tokens ?? 0,
            output_tokens: usage.output_tokens ?? 0,
            cache_creation_input_tokens: usage.cache_creation_input_tokens,
            cache_read_input_tokens: usage.cache_read_input_tokens,
          } : undefined

          const toolNames = pending.blocks
            .filter(b => b.type === 'tool_use' && b.name)
            .map(b => b.name!)

          yield {
            id: pending.uuid,
            sessionId: pending.sessionId ?? '',
            role: 'assistant',
            timestamp: pending.timestamp,
            contentBlocks: pending.blocks,
            model: pending.model,
            tokenUsage,
            toolNames: toolNames.length > 0 ? toolNames : undefined,
            isError: false,
            isCorrection: false,
            requestId: pending.requestId,
            parentUuid: pending.parentUuid,
            uuid: pending.uuid,
          }

          pendingAssistant.delete(key)
        }
      } else if (parsed.type === 'user') {
        const isTextInput = typeof message.content === 'string'
        const contentBlocks: ContentBlock[] = isTextInput
          ? [{ type: 'text', text: message.content as string }]
          : Array.isArray(message.content)
            ? (message.content as ContentBlock[])
            : []

        const isError = this.detectError(parsed.toolUseResult, contentBlocks)

        yield {
          id: parsed.uuid ?? '',
          sessionId: parsed.sessionId ?? '',
          role: 'user',
          timestamp: parsed.timestamp ?? '',
          contentBlocks,
          isError,
          isCorrection: false, // Set by caller with conversation context
          parentUuid: parsed.parentUuid,
          uuid: parsed.uuid ?? '',
        }
      } else if (parsed.type === 'system') {
        yield {
          id: parsed.uuid ?? '',
          sessionId: parsed.sessionId ?? '',
          role: 'system',
          timestamp: parsed.timestamp ?? '',
          contentBlocks: typeof message.content === 'string'
            ? [{ type: 'text', text: message.content }]
            : [],
          isError: false,
          isCorrection: false,
          parentUuid: parsed.parentUuid,
          uuid: parsed.uuid ?? '',
        }
      }
    }

    // Emit any incomplete assistant turns (session ended mid-stream)
    for (const [, pending] of pendingAssistant) {
      yield {
        id: pending.uuid,
        sessionId: pending.sessionId ?? '',
        role: 'assistant',
        timestamp: pending.timestamp,
        contentBlocks: pending.blocks,
        model: pending.model,
        isError: false,
        isCorrection: false,
        requestId: pending.requestId,
        parentUuid: pending.parentUuid,
        uuid: pending.uuid,
      }
    }
  }

  private detectError(toolUseResult: unknown, contentBlocks: readonly ContentBlock[]): boolean {
    if (typeof toolUseResult === 'string' && toolUseResult.toLowerCase().includes('error')) {
      return true
    }
    if (typeof toolUseResult === 'object' && toolUseResult !== null) {
      const r = toolUseResult as Record<string, unknown>
      if (r.stderr && typeof r.stderr === 'string' && r.stderr.length > 0) return true
    }
    // Check tool_result content for is_error flag
    for (const block of contentBlocks) {
      if (block.type === 'tool_result' && (block as any).is_error) return true
    }
    return false
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/adapters/claude-code/conversation-parser.test.ts`
Expected: all tests pass

- [ ] **Step 5: Add fixture with multi-block assistant response**

Add a fixture JSONL file with a thinking block + text block + tool_use block (same `requestId`, `stop_reason: null` on first two, `stop_reason: "tool_use"` on last). Add test verifying all 3 blocks end up in one NormalizedMessage.

- [ ] **Step 6: Run tests**

Run: `npx vitest run src/adapters/claude-code/conversation-parser.test.ts`
Expected: all pass

- [ ] **Step 7: Commit**

```bash
git add src/adapters/claude-code/conversation-parser.ts src/adapters/claude-code/conversation-parser.test.ts fixtures/
git commit -m "feat: add conversation parser with content block grouping"
```

---

### Task 7: Claude Code Adapter — Memory, Config, Subagent, FileChange Parsers

**Files:**
- Create: `src/adapters/claude-code/memory-reader.ts`
- Create: `src/adapters/claude-code/memory-reader.test.ts`
- Create: `src/adapters/claude-code/config-reader.ts`
- Create: `src/adapters/claude-code/config-reader.test.ts`
- Create: `src/adapters/claude-code/subagent-parser.ts`
- Create: `src/adapters/claude-code/subagent-parser.test.ts`
- Create: `src/adapters/claude-code/file-change-extractor.ts`
- Create: `src/adapters/claude-code/file-change-extractor.test.ts`
- Create: `src/adapters/claude-code/tool-result-resolver.ts`

These are simpler parsers. Group into one task since each is small.

- [ ] **Step 1: Write memory-reader test**

Test: reads MEMORY.md, parses frontmatter from individual files, handles missing memory dir.

Memory frontmatter format:
```
---
name: some-name
description: one-line
type: user|feedback|project|reference
---
body content
```

MEMORY.md format: `- [Name](file.md) --- description`

- [ ] **Step 2: Implement memory-reader.ts**

Parse YAML frontmatter (simple regex — only 3 fields, no need for a YAML library).
Key: separator in MEMORY.md is `---` (three hyphens), not em-dash.

- [ ] **Step 3: Run memory-reader tests**

Run: `npx vitest run src/adapters/claude-code/memory-reader.test.ts`
Expected: pass

- [ ] **Step 4: Write config-reader test**

Test: reads CLAUDE.md content, parses settings.json, reads stats-cache.json.
Handles missing files gracefully (return undefined, not throw).
NOTE: For CLAUDE.md, the config reader accepts the claude data directory as its root and reads `settings.json`, `settings.local.json`, `stats-cache.json`, and `CLAUDE.md` from there. For project-level CLAUDE.md, accept the path as a parameter rather than deriving from slug (slug→path conversion is lossy). Use fixture files within the test fixture directory — do NOT read from real filesystem paths derived from slugs.

- [ ] **Step 5: Implement config-reader.ts**

Reads: global CLAUDE.md from `{claudeDir}/CLAUDE.md`, settings.json, settings.local.json, stats-cache.json from claude dir. For project-level CLAUDE.md, accept explicit project path parameter (resolved by caller from session cwd data, not from slug heuristic).

- [ ] **Step 6: Run config-reader tests**

Run: `npx vitest run src/adapters/claude-code/config-reader.test.ts`
Expected: pass

- [ ] **Step 7: Write subagent-parser test**

Test: reads .meta.json for type/description, parses subagent JSONL (isSidechain: true, has agentId). Handles missing .meta.json (pre-2.1.80).

Fixture: create `fixtures/claude-home/projects/-home-test-project-alpha/aaaaaaaa-1111-2222-3333-444444444444/subagents/agent-a1234567890abcdef.jsonl` and `.meta.json`.

- [ ] **Step 8: Implement subagent-parser.ts**

Key: subagent JSONL has same format as parent but with `isSidechain: true` and `agentId` on every line. `sessionId` in subagent lines is the PARENT session ID.

- [ ] **Step 9: Run subagent-parser tests**

Run: `npx vitest run src/adapters/claude-code/subagent-parser.test.ts`
Expected: pass

- [ ] **Step 10: Write file-change-extractor test**

Test: extracts file operations from `file-history-snapshot` entries in JSONL. Handles both relative and absolute path keys in `trackedFileBackups`.

- [ ] **Step 11: Implement file-change-extractor.ts**

Parse `file-history-snapshot` lines from JSONL. Extract file paths and operations from `trackedFileBackups` keys. `backupFileName: null` at v1 = file was created. Non-null = file was modified.

- [ ] **Step 12: Run file-change-extractor tests**

Run: `npx vitest run src/adapters/claude-code/file-change-extractor.test.ts`
Expected: pass

- [ ] **Step 13: Create tool-result-resolver.ts**

Stub for now — resolves `<persisted-output>` tags to actual file content. Handle 5 naming patterns: `b*.txt`, `toolu_*.txt`, `mcp-*.txt`, `webfetch-*.pdf`, `pdf-*/` (directory).

- [ ] **Step 14: Commit**

```bash
git add src/adapters/claude-code/
git commit -m "feat: add memory, config, subagent, file-change parsers"
```

---

### Task 8: Claude Code Adapter — Composite Adapter

**Files:**
- Create: `src/adapters/claude-code/index.ts`
- Create: `src/adapters/claude-code/index.test.ts`
- Create: `src/services/adapter-registry.ts`
- Create: `src/services/adapter-registry.test.ts`
- Create: `src/services/project-resolver.ts`
- Create: `src/services/project-resolver.test.ts`

Wire all sub-parsers into one `ClaudeCodeAdapter` implementing `SessionAdapter`. Then create the adapter registry that merges results from multiple adapters.

- [ ] **Step 1: Write test for ClaudeCodeAdapter**

Integration test — uses fixture directory, calls each method.

- [ ] **Step 2: Implement ClaudeCodeAdapter**

Composes SessionDiscovery, ConversationParser, MemoryReader, ConfigReader, SubagentParser, FileChangeExtractor, ToolResultResolver. Each method delegates to the right sub-parser.

`checkFreshness`: stat project directories, compare JSONL file sizes against known offsets.

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/adapters/claude-code/index.test.ts`
Expected: pass

- [ ] **Step 4: Write adapter-registry test**

Test: registers adapter, routes queries through it, merges results from multiple adapters.

- [ ] **Step 5: Implement adapter-registry.ts**

```typescript
@injectable()
export class AdapterRegistry {
  private readonly adapters: SessionAdapter[] = []

  registerAdapter(adapter: SessionAdapter): void { ... }

  async *discoverProjects(): AsyncIterable<ProjectMeta> {
    for (const adapter of this.adapters) {
      yield* adapter.discoverProjects()
    }
  }
  // Same pattern for all query methods
}
```

- [ ] **Step 6: Write project-resolver test**

Test: path walk-up logic, resolves subdirectory to project root.

- [ ] **Step 7: Implement project-resolver.ts**

Uses adapter registry's project cache. Walks up directory tree, converts each path to slug, checks against known projects.

- [ ] **Step 8: Run all tests**

Run: `npx vitest run`
Expected: all pass

- [ ] **Step 9: Commit**

```bash
git add src/adapters/claude-code/index.ts src/adapters/claude-code/index.test.ts src/services/adapter-registry.ts src/services/adapter-registry.test.ts src/services/project-resolver.ts src/services/project-resolver.test.ts
git commit -m "feat: add composite adapter, registry, and project resolver"
```

---

### Task 9: Freshness Guard and Search Index

**Files:**
- Create: `src/services/freshness-guard.ts`
- Create: `src/services/freshness-guard.test.ts`
- Create: `src/services/search-index.ts`
- Create: `src/services/search-index.test.ts`

- [ ] **Step 1: Write freshness-guard test**

Test: detects new sessions (file appeared), changed sessions (file grew), unchanged sessions (same size). Returns accurate FreshnessResult. Triggers incremental sync when stale.

- [ ] **Step 2: Implement freshness-guard.ts**

For each known session: `stat()` the JSONL file, compare size to stored `byte_offset`. For project directories: check mtime for new session files. This runs before every query.

```typescript
@injectable()
export class FreshnessGuard {
  async ensureFresh(): Promise<{ syncDurationMs: number }> {
    const start = Date.now()
    const result = await this.adapterRegistry.checkFreshness(...)
    if (result.isStale) {
      await this.syncChanges(result)
    }
    return { syncDurationMs: Date.now() - start }
  }
}
```

- [ ] **Step 3: Run freshness tests**

Expected: pass

- [ ] **Step 4: Write search-index test**

Test: indexes messages into FTS5, searches return ranked results with session context. Test FTS5 query syntax (AND, OR, phrase matching).

- [ ] **Step 5: Implement search-index.ts**

Wraps FTS5 queries. Indexes `content_preview` from messages. Returns results with session_id, message_id, rank, snippet.

- [ ] **Step 6: Run search tests**

Expected: pass

- [ ] **Step 7: Commit**

```bash
git add src/services/freshness-guard.ts src/services/freshness-guard.test.ts src/services/search-index.ts src/services/search-index.test.ts
git commit -m "feat: add freshness guard and FTS5 search index"
```

---

### Task 10: LLM Optimization Layer — Token Budget, Pagination, Response Formatter

**Files:**
- Create: `src/services/token-budget-manager.ts`
- Create: `src/services/token-budget-manager.test.ts`
- Create: `src/services/pagination-manager.ts`
- Create: `src/services/pagination-manager.test.ts`
- Create: `src/services/response-formatter.ts`
- Create: `src/services/response-formatter.test.ts`

- [ ] **Step 1: Write token-budget-manager test**

Test cases:
- Content within budget → returned as-is
- Content exceeds budget → truncated at turn boundaries
- Truncation preserves: first message, last message, error messages, correction messages
- Truncation drops: thinking blocks, large tool results (keeps tool name + params)
- Token estimation: ~4 chars per token heuristic

- [ ] **Step 2: Implement token-budget-manager.ts**

Smart truncation rules in code:
1. Estimate total tokens from content
2. If within budget, return all
3. Otherwise, score each message: errors get high priority, corrections high, first/last high, thinking blocks zero
4. Greedily include highest-priority messages until budget exhausted
5. Insert `[... N messages truncated ...]` markers at gaps

- [ ] **Step 3: Run tests**

Expected: pass

- [ ] **Step 4: Write pagination-manager test**

Test: cursor encode/decode (base64 of `{offset, limit}`), windowing math, hasMore detection.

- [ ] **Step 5: Implement pagination-manager.ts**

Cursor is base64-encoded JSON `{offset: number}`. Decode → query with offset/limit → encode next cursor if more results.

- [ ] **Step 6: Write response-formatter test**

Test: shapes data into `ToolResponse<T>` with correct meta fields.

- [ ] **Step 7: Implement response-formatter.ts**

Adds `ResponseMeta` to every response. Accepts raw data + pagination + sync info, returns `ToolResponse<T>`.

- [ ] **Step 8: Run all tests**

Run: `npx vitest run`
Expected: all pass

- [ ] **Step 9: Commit**

```bash
git add src/services/token-budget-manager.ts src/services/token-budget-manager.test.ts src/services/pagination-manager.ts src/services/pagination-manager.test.ts src/services/response-formatter.ts src/services/response-formatter.test.ts
git commit -m "feat: add token budget manager, pagination, response formatter"
```

---

### Task 11: Local LLM Client and Summary Service

**Files:**
- Create: `src/services/local-llm-client.ts`
- Create: `src/services/local-llm-client.test.ts`
- Create: `src/services/summary-service.ts`
- Create: `src/services/summary-service.test.ts`

- [ ] **Step 1: Write local-llm-client test**

Test with mock HTTP (vitest mock of fetch). Verify correct request format (OpenAI-compatible), timeout handling, error handling when LLM is unreachable.

- [ ] **Step 2: Implement local-llm-client.ts**

```typescript
@injectable()
export class LocalLlmClient {
  constructor(
    @inject(TOKENS.LocalLlmUrl) private readonly baseUrl: string,
    @inject(TOKENS.LocalLlmModel) private readonly model: string,
  ) {}

  async summarize(content: string, maxTokens: number = 500): Promise<string> {
    // POST to {baseUrl}/chat/completions with system prompt for summarization
  }
}
```

System prompt: "Summarize the following conversation excerpt concisely. Focus on: what was attempted, what succeeded, what failed, and what the user corrected. Be specific about tool names and file paths."

- [ ] **Step 3: Run tests**

Expected: pass

- [ ] **Step 4: Write summary-service test**

Test: generates summary via LLM client, caches in SQLite, returns cached on second call. Test with mock LLM client injected via DI.

- [ ] **Step 5: Implement summary-service.ts**

Check SQLite `summaries` table first. If hit, return cached. If miss, call LocalLlmClient, store result, return.

- [ ] **Step 6: Run tests**

Expected: pass

- [ ] **Step 7: Commit**

```bash
git add src/services/local-llm-client.ts src/services/local-llm-client.test.ts src/services/summary-service.ts src/services/summary-service.test.ts
git commit -m "feat: add local LLM client and summary caching service"
```

---

### Task 12: Analyzer Service

**Files:**
- Create: `src/services/analyzer.ts`
- Create: `src/services/analyzer.test.ts`

- [ ] **Step 1: Write analyzer test**

Test each metric type against a pre-populated SQLite database:
- `errors`: returns sessions/messages with most errors, ranked
- `corrections`: returns sessions with most user corrections
- `tool_failures`: returns tools with highest failure rates
- `costly_sessions`: returns sessions by token cost, descending
- `frequent_files`: returns most frequently modified files across sessions

- [ ] **Step 2: Implement analyzer.ts**

Pure SQL aggregation queries. Each metric is a method returning structured results.

```typescript
@injectable()
export class Analyzer {
  analyzeErrors(filter): AnalysisResult[] {
    // SELECT session_id, COUNT(*) as error_count FROM messages
    // WHERE is_error = 1 GROUP BY session_id ORDER BY error_count DESC
  }
  // Similar for each metric
}
```

- [ ] **Step 3: Run tests**

Expected: pass

- [ ] **Step 4: Commit**

```bash
git add src/services/analyzer.ts src/services/analyzer.test.ts
git commit -m "feat: add analyzer service with aggregation queries"
```

---

### Task 13: MCP Server Bootstrap and First Tool (list_projects)

**Files:**
- Modify: `src/server.ts`
- Modify: `src/container/modules.ts`
- Create: `src/tools/list-projects.ts`
- Create: `src/tools/index.ts`

This is where we get a working MCP server that can be hot-reloaded in Claude Code.

- [ ] **Step 1: Update server.ts to boot MCP server**

```typescript
import 'reflect-metadata'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { registerAll } from './container'
import { registerTools } from './tools'

async function main() {
  registerAll()

  const server = new McpServer({
    name: 'claude-session-mcp',
    version: '0.1.0',
  })

  registerTools(server)

  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('claude-session-mcp server running on stdio')
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
```

- [ ] **Step 2: Update container/modules.ts to register all services**

Wire all services created in Tasks 3-12 into the DI container.

- [ ] **Step 3: Implement list-projects tool**

```typescript
// src/tools/list-projects.ts
import { container } from 'tsyringe'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

export function registerListProjects(server: McpServer): void {
  server.tool(
    'list_projects',
    'List all known projects with session counts, last activity, and memory/config status',
    {
      sortBy: z.enum(['recent', 'sessions', 'name']).optional(),
      limit: z.number().optional(),
    },
    async (params) => {
      // Resolve services from DI
      // Call freshness guard
      // Query adapter registry
      // Format response
      return {
        content: [{ type: 'text', text: JSON.stringify(response) }],
      }
    }
  )
}
```

- [ ] **Step 4: Create tools/index.ts**

```typescript
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerListProjects } from './list-projects'

export function registerTools(server: McpServer): void {
  registerListProjects(server)
  // More tools added in subsequent tasks
}
```

- [ ] **Step 5: Test live — configure MCP in Claude Code**

Add to `~/.claude/settings.local.json` (or project settings):
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

Start a new Claude Code session and call `list_projects`. Verify it returns real project data.

- [ ] **Step 6: Commit**

```bash
git add src/server.ts src/container/modules.ts src/tools/
git commit -m "feat: boot MCP server with list_projects tool"
```

---

### Task 14a: Core MCP Tools (get_project, list_sessions, get_session, get_conversation)

**Files:**
- Create: `src/tools/get-project.ts`
- Create: `src/tools/list-sessions.ts`
- Create: `src/tools/get-session.ts`
- Create: `src/tools/get-conversation.ts`
- Create: `src/tools/get-conversation.test.ts`
- Modify: `src/tools/index.ts`

- [ ] **Step 1: Implement get_project**

Accepts `project` or `path`. Returns CLAUDE.md content, settings, memory entries, session list, stats. Detail levels: `summary` (just metadata), `full` (everything).

- [ ] **Step 2: Live test get_project**

- [ ] **Step 3: Implement list_sessions**

Accepts project/path filter, branch, dateRange, pagination. Queries sessions table with filters. Returns sorted list with metadata.

- [ ] **Step 4: Live test list_sessions**

- [ ] **Step 5: Implement get_session**

Returns session detail — metadata, turn count, model, token usage, files touched, subagent list. Detail levels: `summary`, `metadata`, `full`.

- [ ] **Step 6: Live test get_session**

- [ ] **Step 7: Write get_conversation unit test**

Test token budgeting integration, window filtering (start/end/errors/corrections), role filtering. Use fixture JSONL data via ConversationParser + TokenBudgetManager with controlled budget.

- [ ] **Step 8: Implement get_conversation**

The most complex tool. Accepts sessionId, maxTokens, roles filter, includeToolResults, window, pagination. Reads from JSONL (not index), applies token budget manager, returns windowed content.

Window types:
- `start` — first N messages within budget
- `end` — last N messages within budget
- `errors` — only messages flagged as errors + surrounding context
- `corrections` — only user corrections + the assistant turn they corrected

- [ ] **Step 9: Run get_conversation tests**

Run: `npx vitest run src/tools/get-conversation.test.ts`
Expected: pass

- [ ] **Step 10: Live test get_conversation**

- [ ] **Step 11: Register tools in index.ts and commit**

```bash
git add src/tools/get-project.ts src/tools/list-sessions.ts src/tools/get-session.ts src/tools/get-conversation.ts src/tools/get-conversation.test.ts src/tools/index.ts
git commit -m "feat: add core MCP tools (get_project, list_sessions, get_session, get_conversation)"
```

---

### Task 14b: Query MCP Tools (search, get_changes, get_memory, analyze)

**Files:**
- Create: `src/tools/search.ts`
- Create: `src/tools/get-changes.ts`
- Create: `src/tools/get-memory.ts`
- Create: `src/tools/analyze.ts`
- Create: `src/tools/analyze.test.ts`
- Modify: `src/tools/index.ts`

- [ ] **Step 1: Implement search**

FTS5 query through search index. Returns ranked results with session context (project, branch, timestamp). Supports project/path filter and dateRange.

- [ ] **Step 2: Live test search**

- [ ] **Step 3: Implement get_changes**

Query file_changes table. Filter by session, file path, operation type. Pagination.

- [ ] **Step 4: Live test get_changes**

- [ ] **Step 5: Implement get_memory**

Query memory_entries across all projects. Filter by project/path, type, text search on content.

- [ ] **Step 6: Live test get_memory**

- [ ] **Step 7: Write analyze unit test**

Test each metric type against pre-populated SQLite: errors, corrections, tool_failures, costly_sessions, frequent_files. Verify correct ranking and filtering.

- [ ] **Step 8: Implement analyze**

Route to Analyzer service by metric type. Apply project/dateRange filters. Return ranked results.

- [ ] **Step 9: Run analyze tests**

Run: `npx vitest run src/tools/analyze.test.ts`
Expected: pass

- [ ] **Step 10: Live test analyze**

- [ ] **Step 11: Register all remaining tools in index.ts and commit**

```bash
git add src/tools/search.ts src/tools/get-changes.ts src/tools/get-memory.ts src/tools/analyze.ts src/tools/analyze.test.ts src/tools/index.ts
git commit -m "feat: add query MCP tools (search, get_changes, get_memory, analyze)"
```

---

### Task 15: E2E Integration Tests

**Files:**
- Create: `src/tools/tools.e2e.test.ts`

- [ ] **Step 1: Write E2E test harness**

Set up MCP server with fixture `~/.claude/` directory. Use MCP SDK's client to call tools programmatically.

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
// Create in-memory transport pair for testing
```

- [ ] **Step 2: Write E2E tests for each tool**

Test list_projects, get_project (with path resolution), list_sessions (with filters), get_session, get_conversation (with token budget and windows), search (FTS5), get_changes, get_memory (cross-project), analyze (each metric).

- [ ] **Step 3: Write freshness E2E test**

Add a new JSONL file mid-test. Next query should pick it up without restart.

- [ ] **Step 4: Run all tests**

Run: `npx vitest run`
Expected: all pass

- [ ] **Step 5: Commit**

```bash
git add src/tools/tools.e2e.test.ts
git commit -m "test: add E2E tests for all MCP tools"
```

---

### Task 16: Polish and Documentation

**Files:**
- Modify: `CLAUDE.md` — add MCP server configuration instructions
- Modify: `package.json` — verify scripts work
- Create: `src/services/index.ts` — barrel export for services

- [ ] **Step 1: Add barrel exports for services**

- [ ] **Step 2: Update CLAUDE.md with dev instructions**

Add: how to run dev server, how to configure in Claude Code, how to run tests.

- [ ] **Step 3: Verify full test suite**

Run: `npx vitest run`
Expected: all pass

- [ ] **Step 4: Verify live hot-reload workflow**

Run: `npm run dev` — verify tsx --watch restarts on file changes and Claude Code reconnects.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat: complete v1 of claude-session-mcp server"
```
