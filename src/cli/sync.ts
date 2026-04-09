#!/usr/bin/env tsx
/**
 * Standalone sync entry point intended to be wired as a Claude Code Stop hook
 * so the session index is warmed immediately when a session ends, instead of
 * lazily on the next MCP tool call.
 *
 * Usage (Claude Code settings.json):
 *
 *   {
 *     "hooks": {
 *       "Stop": [{
 *         "matcher": "",
 *         "hooks": [{
 *           "type": "command",
 *           "command": "npx tsx /home/kitty/Desktop/claude-session-mcp/src/cli/sync.ts"
 *         }]
 *       }]
 *     }
 *   }
 *
 * The script is idempotent and fast when there is nothing to sync — it reuses
 * the same FreshnessGuard pipeline that MCP tool calls use. Exits 0 on
 * success, 1 on failure. Output is a single-line JSON summary so hook
 * environments can log it without noise.
 */

import 'reflect-metadata'
import { container } from 'tsyringe'
import { registerAll } from '../container/modules'
import { TOKENS } from '../container/tokens'
import type { FreshnessGuard } from '../services/freshness-guard'
import type { EmbeddingIndexer } from '../services/embedding-indexer'

async function main(): Promise<void> {
  registerAll()
  const guard = container.resolve<FreshnessGuard>(TOKENS.FreshnessGuard)
  const result = await guard.ensureFresh()

  // The MCP server's ensureFresh fires embedding indexing as a
  // fire-and-forget promise because it has a long-running process to
  // handle it. The CLI exits as soon as ensureFresh resolves, which kills
  // that promise — so the CLI must await the indexer explicitly to be
  // useful as a Stop hook.
  const indexer = container.resolve<EmbeddingIndexer | null>(TOKENS.EmbeddingIndexer)
  let embeddedThisCycle = 0
  let embeddingError: string | null = null
  if (indexer) {
    try {
      embeddedThisCycle = await indexer.indexPending()
    } catch (err) {
      embeddingError = err instanceof Error ? err.message : String(err)
    }
  }

  process.stdout.write(
    JSON.stringify({ ok: true, ...result, embeddedThisCycle, embeddingError }) + '\n',
  )
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err)
  process.stderr.write(JSON.stringify({ ok: false, error: message }) + '\n')
  process.exit(1)
})
