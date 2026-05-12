import type { SessionMetadataResult } from '../../types/adapter'
import { streamJsonlLines } from '../../infrastructure/file-system'

/**
 * Pi has no title/tag/PR-link/mode/worktree concept in its JSONL. We synthesize the
 * minimum SessionMetadataResult: first user turn becomes ai-title heuristic, nothing else.
 */
export class PiMetadataParser {
  async extractMetadata(sessionPath: string): Promise<SessionMetadataResult> {
    let aiTitle: string | undefined

    for await (const { line } of streamJsonlLines(sessionPath)) {
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }

      if (parsed.type !== 'message') continue
      const message = parsed.message as { role?: string; content?: unknown } | undefined
      if (message?.role !== 'user') continue
      if (!Array.isArray(message.content)) continue

      for (const blk of message.content as Array<{ type?: string; text?: unknown }>) {
        if (blk?.type === 'text' && typeof blk.text === 'string' && blk.text.trim().length > 0) {
          const first = blk.text.trim().split('\n')[0]
          aiTitle = first.length > 100 ? first.slice(0, 97) + '...' : first
          break
        }
      }
      if (aiTitle) break
    }

    return {
      customTitle: undefined,
      aiTitle,
      tags: [],
      mode: undefined,
      prLinks: [],
      collapses: [],
      taskSummaries: [],
      worktreeBranch: undefined,
      worktreePath: undefined,
      speculationTimeSavedMs: 0,
    }
  }
}
