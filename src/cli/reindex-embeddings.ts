#!/usr/bin/env tsx
/**
 * One-shot bulk embedding indexer. Unlike `sync.ts` this keeps the Node
 * process alive across many indexPending cycles so we pay the tsx + DI +
 * schema-load overhead once, not once per 500 messages.
 *
 * Usage (env vars required):
 *   VLLM_EMBEDDING_URL=... VLLM_EMBEDDING_MODEL=... VLLM_EMBEDDING_DIM=... \
 *     npx tsx src/cli/reindex-embeddings.ts [batchBudget]
 *
 * batchBudget defaults to 2000; the loop exits when a cycle indexes 0.
 */

import 'reflect-metadata'
import { container } from 'tsyringe'
import { registerAll } from '../container/modules'
import { TOKENS } from '../container/tokens'
import type { FreshnessGuard } from '../services/freshness-guard'
import type { EmbeddingIndexer } from '../services/embedding-indexer'

async function main(): Promise<void> {
  const budget = Number(process.argv[2] ?? '2000')

  registerAll()

  // Run ensureFresh once so any new messages land before we start indexing.
  const guard = container.resolve<FreshnessGuard>(TOKENS.FreshnessGuard)
  await guard.ensureFresh()

  const indexer = container.resolve<EmbeddingIndexer | null>(TOKENS.EmbeddingIndexer)
  if (!indexer) {
    process.stderr.write('reindex-embeddings: VLLM_EMBEDDING_MODEL is not set — nothing to do\n')
    process.exit(1)
  }

  let totalIndexed = 0
  let cycle = 0
  for (;;) {
    cycle++
    const start = Date.now()
    const count = await indexer.indexPending(budget)
    const ms = Date.now() - start
    process.stdout.write(
      `cycle=${cycle} indexed=${count} cumulative=${totalIndexed + count} ms=${ms}\n`,
    )
    totalIndexed += count
    if (count === 0) break
  }

  process.stdout.write(`done totalIndexed=${totalIndexed}\n`)
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err)
  process.stderr.write(`reindex-embeddings failed: ${message}\n`)
  process.exit(1)
})
