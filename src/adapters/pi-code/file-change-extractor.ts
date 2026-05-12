import { basename } from 'node:path'
import type { FileChange } from '../../types'
import { streamJsonlLines } from '../../infrastructure/file-system'
import { extractSessionIdFromFilename } from './session-discovery'

interface PiToolCall {
  type?: string
  id?: string
  name?: string
  arguments?: Record<string, unknown>
}

/**
 * Map a pi toolCall name to the FileChange operation, or undefined if it's not a
 * file mutation/read worth recording.
 */
function operationFor(name: string | undefined): FileChange['operation'] | undefined {
  switch (name) {
    case 'write':
    case 'create':
      return 'write'
    case 'edit':
      return 'edit'
    case 'read':
      return 'read'
    default:
      return undefined
  }
}

export class PiFileChangeExtractor {
  async *extractChanges(sessionPath: string): AsyncIterable<FileChange> {
    const sessionId = extractSessionIdFromFilename(basename(sessionPath)) ?? basename(sessionPath, '.jsonl')

    for await (const { line } of streamJsonlLines(sessionPath)) {
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }

      if (parsed['type'] !== 'message') continue
      const message = parsed['message'] as { role?: string; content?: unknown } | undefined
      if (message?.role !== 'assistant') continue
      if (!Array.isArray(message.content)) continue

      const messageId = parsed['id'] as string | undefined
      const timestamp = (parsed['timestamp'] as string | undefined) ?? new Date().toISOString()

      for (const blk of message.content as PiToolCall[]) {
        if (blk?.type !== 'toolCall') continue
        const op = operationFor(blk.name)
        if (!op) continue
        const args = blk.arguments
        if (!args || typeof args !== 'object') continue
        const path = (args as { path?: unknown }).path
        if (typeof path !== 'string' || path.length === 0) continue

        yield {
          sessionId,
          messageId,
          filePath: path,
          operation: op,
          timestamp,
        }
      }
    }
  }
}
