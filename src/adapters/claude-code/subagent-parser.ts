import { join } from 'node:path'
import type { SubagentMeta } from '../../types'
import { fileExists, listFiles, readJsonFile, streamJsonlLines } from '../../infrastructure/file-system'

const AGENT_JSONL_RE = /^agent-([a-f0-9]+)\.jsonl$/

interface SubagentMetaFile {
  readonly agentType?: string
  readonly description?: string
  readonly model?: string
}

export class SubagentParser {
  constructor(private readonly claudeDir: string) {}

  private async computeJsonlStats(jsonlPath: string): Promise<{
    totalTokens: number
    totalTools: number
    durationMs: number | undefined
    model: string | undefined
  }> {
    let totalTokens = 0
    let totalTools = 0
    let firstTimestamp: string | undefined
    let lastTimestamp: string | undefined
    let model: string | undefined

    for await (const { line } of streamJsonlLines(jsonlPath)) {
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }

      const timestamp = parsed['timestamp'] as string | undefined
      if (timestamp) {
        if (!firstTimestamp) firstTimestamp = timestamp
        lastTimestamp = timestamp
      }

      const message = parsed['message'] as Record<string, unknown> | undefined
      if (!message) continue

      if (parsed['type'] === 'assistant' && !model && message['model']) {
        model = message['model'] as string
      }

      const usage = message['usage'] as Record<string, number> | undefined
      if (usage) {
        totalTokens += (usage['input_tokens'] ?? 0) + (usage['output_tokens'] ?? 0)
      }

      const content = message['content']
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block && typeof block === 'object' && (block as Record<string, unknown>)['type'] === 'tool_use') {
            totalTools++
          }
        }
      }
    }

    const durationMs = firstTimestamp && lastTimestamp
      ? new Date(lastTimestamp).getTime() - new Date(firstTimestamp).getTime()
      : undefined

    return { totalTokens, totalTools, durationMs, model }
  }

  async *getSubagents(projectSlug: string, sessionId: string): AsyncIterable<SubagentMeta> {
    const subagentsDir = join(
      this.claudeDir,
      'projects',
      projectSlug,
      sessionId,
      'subagents',
    )

    if (!(await fileExists(subagentsDir))) return

    const files = await listFiles(subagentsDir, '.jsonl')
    for (const file of files) {
      const match = AGENT_JSONL_RE.exec(file)
      if (!match || !match[1]) continue

      const agentId = match[1]
      const metaPath = join(subagentsDir, `agent-${agentId}.meta.json`)

      let meta: SubagentMetaFile | undefined
      if (await fileExists(metaPath)) {
        try {
          meta = await readJsonFile<SubagentMetaFile>(metaPath)
        } catch {
          // meta.json missing or malformed — graceful
        }
      }

      const jsonlPath = join(subagentsDir, file)
      const stats = await this.computeJsonlStats(jsonlPath)

      yield {
        id: agentId,
        sessionId,
        agentType: meta?.agentType,
        description: meta?.description,
        totalTokens: stats.totalTokens || undefined,
        totalTools: stats.totalTools || undefined,
        durationMs: stats.durationMs,
        model: stats.model ?? meta?.model,
      }
    }
  }
}
