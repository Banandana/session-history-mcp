import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { FileChangeExtractor } from './file-change-extractor'
import type { FileChange } from '../../types'

const FIXTURES = join(__dirname, '../../../fixtures/claude-home/projects/-home-test-project-alpha')

async function collectChanges(extractor: FileChangeExtractor, sessionPath: string): Promise<FileChange[]> {
  const changes: FileChange[] = []
  for await (const change of extractor.extractChanges(sessionPath)) {
    changes.push(change)
  }
  return changes
}

describe('FileChangeExtractor', () => {
  const extractor = new FileChangeExtractor()

  describe('aaaaaaaa session with file-history-snapshot', () => {
    const sessionPath = join(FIXTURES, 'aaaaaaaa-1111-2222-3333-444444444444.jsonl')

    it('extracts file changes from snapshot with isSnapshotUpdate: true', async () => {
      const changes = await collectChanges(extractor, sessionPath)
      expect(changes.length).toBeGreaterThanOrEqual(2)

      const paths = changes.map(c => c.filePath)
      expect(paths).toContain('src/auth.ts')
      expect(paths).toContain('CLAUDE.md')
    })

    it('detects create operation when backupFileName is null', async () => {
      const changes = await collectChanges(extractor, sessionPath)
      const authChange = changes.find(c => c.filePath === 'src/auth.ts')!
      expect(authChange.operation).toBe('create')
    })

    it('detects edit operation when backupFileName is non-null', async () => {
      const changes = await collectChanges(extractor, sessionPath)
      const claudeChange = changes.find(c => c.filePath === 'CLAUDE.md')!
      expect(claudeChange.operation).toBe('edit')
    })

    it('sets correct sessionId and messageId', async () => {
      const changes = await collectChanges(extractor, sessionPath)
      for (const change of changes) {
        expect(change.sessionId).toBe('aaaaaaaa-1111-2222-3333-444444444444')
        expect(change.messageId).toBe('msg-2')
      }
    })

    it('sets timestamp from snapshot', async () => {
      const changes = await collectChanges(extractor, sessionPath)
      for (const change of changes) {
        expect(change.timestamp).toBe('2026-03-28T10:00:06Z')
      }
    })
  })

  describe('cccccccc session with empty snapshot', () => {
    const sessionPath = join(FIXTURES, 'cccccccc-1111-2222-3333-444444444444.jsonl')

    it('skips snapshots with isSnapshotUpdate: false', async () => {
      const changes = await collectChanges(extractor, sessionPath)
      // cccccccc has only an empty snapshot with isSnapshotUpdate: false
      expect(changes).toHaveLength(0)
    })
  })
})
