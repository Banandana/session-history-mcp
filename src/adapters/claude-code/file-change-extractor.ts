import { basename } from 'node:path'
import type { FileChange } from '../../types'
import { streamJsonlLines } from '../../infrastructure/file-system'

interface TrackedFileBackup {
  readonly version: number
  readonly backupFileName: string | null
}

interface FileHistorySnapshot {
  readonly type: 'file-history-snapshot'
  readonly messageId: string
  readonly snapshot: {
    readonly messageId: string
    readonly trackedFileBackups: Record<string, TrackedFileBackup>
    readonly timestamp: string
  }
  readonly isSnapshotUpdate: boolean
}

function isFileHistorySnapshot(parsed: Record<string, unknown>): parsed is Record<string, unknown> & FileHistorySnapshot {
  return parsed.type === 'file-history-snapshot' && parsed.snapshot != null
}

export class FileChangeExtractor {
  async *extractChanges(sessionPath: string): AsyncIterable<FileChange> {
    const sessionId = basename(sessionPath, '.jsonl')

    for await (const { line } of streamJsonlLines(sessionPath)) {
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }

      if (!isFileHistorySnapshot(parsed)) continue

      const snapshot = parsed as unknown as FileHistorySnapshot
      if (!snapshot.isSnapshotUpdate) continue

      const backups = snapshot.snapshot.trackedFileBackups
      if (!backups || typeof backups !== 'object') continue

      for (const [filePath, backup] of Object.entries(backups)) {
        const operation = backup.backupFileName === null ? 'create' : 'edit'

        yield {
          sessionId,
          messageId: snapshot.messageId,
          filePath,
          operation,
          timestamp: snapshot.snapshot.timestamp,
        }
      }
    }
  }
}
