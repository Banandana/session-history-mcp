import 'reflect-metadata'
import { injectable, inject } from 'inversify'
import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { TOKENS } from '../container/tokens'

@injectable()
export class DatabaseConnection {
  private db: Database.Database | null = null
  private vecLoaded = false

  constructor(
    @inject(TOKENS.ClaudeDataDir) private readonly claudeDir: string
  ) {}

  get(): Database.Database {
    if (!this.db) {
      this.db = new Database(`${this.claudeDir}/session-mcp-index.db`)
      this.db.pragma('journal_mode = WAL')
      this.db.pragma('foreign_keys = ON')
      this.db.pragma('synchronous = NORMAL')

      // sqlite-vec provides the vec0 virtual table used by semantic search.
      // Loading it is best-effort — on platforms without a prebuilt binary
      // the semantic_search tool will surface the error at query time.
      try {
        sqliteVec.load(this.db)
        this.vecLoaded = true
      } catch {
        this.vecLoaded = false
      }
    }
    return this.db
  }

  /** True if the sqlite-vec extension loaded successfully. */
  isVecAvailable(): boolean {
    if (!this.db) this.get()
    return this.vecLoaded
  }

  close(): void {
    this.db?.close()
    this.db = null
  }
}
