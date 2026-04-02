import 'reflect-metadata'
import { injectable, inject } from 'tsyringe'
import type Database from 'better-sqlite3'
import { TOKENS } from '../container/tokens'
import type { DatabaseConnection } from '../infrastructure/database'

@injectable()
export class IndexManager {
  private db: Database.Database

  constructor(
    @inject(TOKENS.Database) dbOrConnection: Database.Database | DatabaseConnection
  ) {
    if ('get' in dbOrConnection && typeof (dbOrConnection as DatabaseConnection).get === 'function') {
      this.db = (dbOrConnection as DatabaseConnection).get()
    } else {
      this.db = dbOrConnection as Database.Database
    }
  }

  ensureSchema(): void {
    // Step 1: Create base tables (columns that exist since v0, minus summaries)
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
        indexed_at TEXT
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
    `)

    // Step 2: Run versioned migrations (adds columns, drops summaries, creates new indexes)
    this.runMigrations()
  }

  private runMigrations(): void {
    const userVersion = this.db.pragma('user_version', { simple: true }) as number

    if (userVersion < 1) {
      this.db.transaction(() => {
        this.migrateToV1()
      })()
    }
    if (userVersion < 2) {
      this.db.transaction(() => {
        this.migrateToV2()
      })()
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

  private hasColumn(table: string, column: string): boolean {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    return rows.some(r => r.name === column)
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    if (!this.hasColumn(table, column)) {
      try {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
      } catch (err) {
        // Column may have been added concurrently — verify it exists now
        if (!this.hasColumn(table, column)) throw err
      }
    }
  }

  private migrateToV1(): void {
    this.addColumnIfMissing('sessions', 'ended_at', 'TEXT')
    this.addColumnIfMissing('sessions', 'duration_minutes', 'INTEGER')
    this.addColumnIfMissing('sessions', 'message_count', 'INTEGER DEFAULT 0')
    this.addColumnIfMissing('sessions', 'error_count', 'INTEGER DEFAULT 0')
    this.addColumnIfMissing('sessions', 'correction_count', 'INTEGER DEFAULT 0')
    this.addColumnIfMissing('sessions', 'subagent_count', 'INTEGER DEFAULT 0')
    this.addColumnIfMissing('sessions', 'tool_counts', 'TEXT')
    this.addColumnIfMissing('sessions', 'files_changed', 'TEXT')
    this.addColumnIfMissing('sessions', 'topic', 'TEXT')
    this.addColumnIfMissing('sessions', 'summary', 'TEXT')
    this.addColumnIfMissing('sessions', 'summary_generated_at', 'TEXT')

    // Drop the summaries table — replaced by columns on sessions
    this.db.exec(`DROP TABLE IF EXISTS summaries`)

    // New sort indexes (idempotent via IF NOT EXISTS)
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_duration ON sessions(duration_minutes);
      CREATE INDEX IF NOT EXISTS idx_sessions_total_turns ON sessions(total_turns);
      CREATE INDEX IF NOT EXISTS idx_sessions_error_count ON sessions(error_count);
      CREATE INDEX IF NOT EXISTS idx_sessions_total_tokens ON sessions(total_tokens);
    `)

    this.db.pragma('user_version = 1')
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
