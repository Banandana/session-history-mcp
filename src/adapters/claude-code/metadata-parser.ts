import { basename } from 'node:path'
import type { PrLink, ContextCollapse } from '../../types'
import type { SessionMetadataResult } from '../../types/adapter'
import { streamJsonlLines } from '../../infrastructure/file-system'

/**
 * Extracts session-level metadata entries from JSONL that the conversation parser skips.
 * These are non-message entries like titles, tags, PR links, mode, worktree state, etc.
 */
export class MetadataParser {
  async extractMetadata(sessionPath: string): Promise<SessionMetadataResult> {
    const sessionId = basename(sessionPath, '.jsonl')

    let customTitle: string | undefined
    let aiTitle: string | undefined
    const tags: string[] = []
    let mode: 'coordinator' | 'normal' | undefined
    const prLinks: PrLink[] = []
    const collapses: ContextCollapse[] = []
    const taskSummaries: string[] = []
    let worktreeBranch: string | undefined
    let worktreePath: string | undefined
    let speculationTimeSavedMs = 0
    let gitBranch: string | undefined

    for await (const { line } of streamJsonlLines(sessionPath)) {
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }

      const lineType = parsed['type'] as string | undefined
      if (!lineType) continue

      if (gitBranch === undefined && (lineType === 'user' || lineType === 'assistant')) {
        const b = parsed['gitBranch']
        if (typeof b === 'string' && b.length > 0) {
          gitBranch = b
        }
      }

      switch (lineType) {
        case 'custom-title':
          customTitle = parsed['customTitle'] as string
          break

        case 'ai-title':
          aiTitle = parsed['aiTitle'] as string
          break

        case 'tag':
          if (typeof parsed['tag'] === 'string') {
            tags.push(parsed['tag'])
          }
          break

        case 'mode':
          if (parsed['mode'] === 'coordinator' || parsed['mode'] === 'normal') {
            mode = parsed['mode']
          }
          break

        case 'pr-link':
          prLinks.push({
            sessionId,
            prNumber: parsed['prNumber'] as number,
            prUrl: parsed['prUrl'] as string,
            prRepository: parsed['prRepository'] as string,
            timestamp: (parsed['timestamp'] as string) ?? new Date().toISOString(),
          })
          break

        case 'marble-origami-commit':
          collapses.push({
            sessionId,
            collapseId: parsed['collapseId'] as string,
            summary: (parsed['summary'] as string) ?? '',
            firstArchivedUuid: parsed['firstArchivedUuid'] as string,
            lastArchivedUuid: parsed['lastArchivedUuid'] as string,
          })
          break

        case 'task-summary':
          if (typeof parsed['summary'] === 'string') {
            taskSummaries.push(parsed['summary'])
          }
          break

        case 'worktree-state': {
          const ws = parsed['worktreeSession'] as Record<string, unknown> | null
          if (ws) {
            worktreeBranch = ws['worktreeBranch'] as string | undefined
            worktreePath = ws['worktreePath'] as string | undefined
          }
          break
        }

        case 'speculation-accept':
          speculationTimeSavedMs += (parsed['timeSavedMs'] as number) ?? 0
          break
      }
    }

    return {
      customTitle,
      aiTitle,
      tags,
      mode,
      prLinks,
      collapses,
      taskSummaries,
      worktreeBranch,
      worktreePath,
      speculationTimeSavedMs,
      gitBranch,
    }
  }
}
