import type Database from 'better-sqlite3'
import type { EmbeddingClient } from './llm-client'

/**
 * Indexes message text into a sqlite-vec virtual table for semantic search.
 *
 * Design notes:
 *  - The virtual table is created lazily on first use because sqlite-vec
 *    needs the vector dimension baked into the schema. If the configured
 *    dimension changes, the old table is dropped (embeddings are recomputed,
 *    never migrated — migration across dimensions is meaningless anyway).
 *  - Indexing runs as a fire-and-forget phase after FreshnessGuard.ensureFresh
 *    so slow embedding calls never block MCP tool responses.
 *  - Batches are intentionally small (MAX_BATCH) so an interrupted run still
 *    commits progress regularly.
 */

const MAX_BATCH = 32
// Per-message input cap. CPU-bound embedding backends (e.g. TEI without
// GPU) are sensitive to input length — shorter inputs embed much faster
// and for retrieval purposes the first few hundred tokens of a message
// usually carry the relevant signal. Configurable via env var so users
// can trade recall for throughput on their hardware.
const MAX_INPUT_CHARS = Number(process.env['EMBEDDING_MAX_CHARS'] ?? '500')
const DEFAULT_BUDGET = 500 // messages per cycle — keeps indexing bounded

export class EmbeddingIndexer {
  private schemaEnsured = false

  constructor(
    private readonly db: Database.Database,
    private readonly client: EmbeddingClient,
    private readonly dim: number,
  ) {}

  /** Ensures the vec0 virtual table + backing tracking column exist. */
  ensureSchema(): void {
    if (this.schemaEnsured) return

    // Track which messages have been embedded. Stored as a column on
    // messages so cross-session queries can join without a separate table.
    const hasColumn = (this.db
      .prepare('PRAGMA table_info(messages)')
      .all() as Array<{ name: string }>
    ).some(r => r.name === 'embedded_at')
    if (!hasColumn) {
      this.db.exec('ALTER TABLE messages ADD COLUMN embedded_at TEXT')
    }

    // Use the implicit rowid pattern — the vec0 table's hidden rowid maps
    // directly to messages.rowid so we can join without a bridge column.
    // This sidesteps a sqlite-vec quirk where declaring an INTEGER PRIMARY
    // KEY column causes the row binding to reject plain JS numbers.
    //
    // Drop any pre-existing table whose schema doesn't match this pattern
    // — during development we experimented with `message_rowid INTEGER
    // PRIMARY KEY` and those tables break at insert time.
    const existing = this.db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='message_embeddings'",
      )
      .get() as { sql: string } | undefined
    if (existing?.sql.includes('message_rowid')) {
      this.db.exec('DROP TABLE IF EXISTS message_embeddings')
      this.db.exec('UPDATE messages SET embedded_at = NULL')
    }

    this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS message_embeddings USING vec0(
        embedding FLOAT[${this.dim}]
      )`,
    )

    // Dimension mismatch handling: probe with a single insert, catch error,
    // drop + recreate if the dim differs. We only do this once per process.
    //
    // sqlite-vec's vec0 virtual table requires BigInt bindings for the
    // rowid column — better-sqlite3 sends plain JS numbers through a code
    // path that the vec0 extension rejects with "Only integers are allowed
    // for primary key values". Converting to BigInt before binding fixes it.
    const probe = new Array(this.dim).fill(0)
    try {
      this.db
        .prepare('INSERT INTO message_embeddings(rowid, embedding) VALUES (?, ?)')
        .run(BigInt(-1), Buffer.from(new Float32Array(probe).buffer))
      this.db.prepare('DELETE FROM message_embeddings WHERE rowid = ?').run(BigInt(-1))
    } catch (err) {
      const msg = (err as Error).message
      if (msg.includes('dimension') || msg.includes('size') || msg.includes('length')) {
        this.db.exec('DROP TABLE IF EXISTS message_embeddings')
        this.db.exec(
          `CREATE VIRTUAL TABLE message_embeddings USING vec0(
            embedding FLOAT[${this.dim}]
          )`,
        )
        this.db.exec('UPDATE messages SET embedded_at = NULL')
      } else {
        throw err
      }
    }

    this.schemaEnsured = true
  }

  /**
   * Index up to `budget` unembedded messages. Returns the number indexed.
   * Safe to call repeatedly — subsequent calls pick up where previous left.
   */
  async indexPending(budget: number = DEFAULT_BUDGET): Promise<number> {
    this.ensureSchema()

    const rows = this.db
      .prepare(
        `SELECT rowid, search_text
         FROM messages
         WHERE embedded_at IS NULL
           AND search_text IS NOT NULL
           AND search_text != ''
         LIMIT ?`,
      )
      .all(budget) as Array<{ rowid: number; search_text: string }>

    if (rows.length === 0) return 0

    // vec0 doesn't support UPDATE; on re-index we delete then insert.
    const deleteEmbedding = this.db.prepare(
      'DELETE FROM message_embeddings WHERE rowid = ?',
    )
    const insertEmbedding = this.db.prepare(
      'INSERT INTO message_embeddings(rowid, embedding) VALUES (?, ?)',
    )
    const markIndexed = this.db.prepare(
      'UPDATE messages SET embedded_at = ? WHERE rowid = ?',
    )

    let indexed = 0
    const now = new Date().toISOString()

    for (let i = 0; i < rows.length; i += MAX_BATCH) {
      const batch = rows.slice(i, i + MAX_BATCH)
      const inputs = batch.map(r => r.search_text.slice(0, MAX_INPUT_CHARS))

      let vectors: readonly (readonly number[])[]
      try {
        vectors = await this.client.embed(inputs)
      } catch (err) {
        // Embedding backend unavailable or errored — stop this cycle but
        // leave already-indexed rows committed. Retry on next cycle. Only
        // rethrow on the first batch so callers can see configuration
        // problems; subsequent batches swallow transient errors.
        if (indexed === 0) throw err
        break
      }

      if (vectors.length !== batch.length) break

      // First-batch dimension mismatch is a configuration error, not a
      // transient issue — abort loudly instead of silently looping forever
      // (every row would fail the vector.length !== this.dim check below
      // and `indexed` would never advance).
      if (i === 0 && vectors[0] && vectors[0].length !== this.dim) {
        throw new Error(
          `Embedding dimension mismatch: configured VLLM_EMBEDDING_DIM=${this.dim} but provider returned ${vectors[0].length}-dim vectors. Set VLLM_EMBEDDING_DIM=${vectors[0].length} or change the model.`,
        )
      }

      this.db.transaction(() => {
        for (let j = 0; j < batch.length; j++) {
          const vector = vectors[j]
          const entry = batch[j]
          if (!vector || !entry || vector.length !== this.dim) continue
          const buf = Buffer.from(new Float32Array(vector).buffer)
          // vec0 requires BigInt for the rowid binding (see ensureSchema).
          const rowid = BigInt(entry.rowid)
          deleteEmbedding.run(rowid)
          insertEmbedding.run(rowid, buf)
          markIndexed.run(now, entry.rowid)
          indexed++
        }
      })()
    }

    return indexed
  }

  /**
   * KNN search. Returns message rowids ordered by similarity (closest first).
   * distance is L2 from sqlite-vec.
   */
  async search(
    query: string,
    k: number,
  ): Promise<ReadonlyArray<{ rowid: number; distance: number }>> {
    this.ensureSchema()

    const vectors = await this.client.embed([query.slice(0, MAX_INPUT_CHARS)])
    const queryVec = vectors[0]
    if (!queryVec) return []
    if (queryVec.length !== this.dim) {
      throw new Error(
        `Query embedding dim ${queryVec.length} does not match index dim ${this.dim}`,
      )
    }

    const buf = Buffer.from(new Float32Array(queryVec).buffer)
    const rows = this.db
      .prepare(
        `SELECT rowid, distance
         FROM message_embeddings
         WHERE embedding MATCH ?
         ORDER BY distance
         LIMIT ?`,
      )
      .all(buf, k) as Array<{ rowid: number; distance: number }>

    return rows
  }
}
