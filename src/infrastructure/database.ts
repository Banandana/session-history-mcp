import 'reflect-metadata'
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
