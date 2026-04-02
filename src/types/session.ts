export type MessageRole = 'user' | 'assistant' | 'system'
export type MessageType = 'user' | 'assistant' | 'system' | 'progress' | 'file-history-snapshot' | 'queue-operation'

export interface ContentBlock {
  readonly type: 'text' | 'tool_use' | 'tool_result' | 'thinking'
  readonly text?: string
  readonly id?: string
  readonly name?: string
  readonly input?: unknown
  readonly tool_use_id?: string
  readonly content?: unknown
  readonly thinking?: string
  readonly signature?: string
}

export interface TokenUsage {
  readonly input_tokens: number
  readonly output_tokens: number
  readonly cache_creation_input_tokens?: number
  readonly cache_read_input_tokens?: number
}

export interface NormalizedMessage {
  readonly id: string
  readonly sessionId: string
  readonly role: MessageRole
  readonly timestamp: string
  readonly contentBlocks: readonly ContentBlock[]
  readonly model?: string
  readonly tokenUsage?: TokenUsage
  readonly toolNames?: readonly string[]
  readonly isError: boolean
  readonly isCorrection: boolean
  readonly hasThinking: boolean
  readonly requestId?: string
  readonly parentUuid?: string | null
  readonly uuid: string
  readonly cwd?: string
  readonly gitBranch?: string
  readonly entrypoint?: string
}

export interface SessionMeta {
  readonly id: string
  readonly source: string
  readonly projectSlug: string
  readonly cwd: string
  readonly branch?: string
  readonly startedAt: string
  readonly endedAt?: string
  readonly durationMinutes?: number
  readonly model?: string
  readonly totalTokens?: number
  readonly totalTurns?: number
  readonly messageCount?: number
  readonly errorCount?: number
  readonly correctionCount?: number
  readonly subagentCount?: number
  readonly toolCounts?: Record<string, number>
  readonly filesChanged?: ReadonlyArray<{ readonly path: string; readonly op: string }>
  readonly topic?: string
  readonly summary?: string
  readonly summaryGeneratedAt?: string
  readonly summaryText?: string
  readonly version?: string
  readonly customTitle?: string
  readonly aiTitle?: string
  readonly tags?: readonly string[]
  readonly costUsd?: number
  readonly mode?: 'coordinator' | 'normal'
  readonly entrypoint?: string
}

export interface SessionMetadataEntry {
  readonly type: string
  readonly sessionId: string
  readonly timestamp?: string
  readonly data: Record<string, unknown>
}

export interface PrLink {
  readonly sessionId: string
  readonly prNumber: number
  readonly prUrl: string
  readonly prRepository: string
  readonly timestamp: string
}

export interface ContextCollapse {
  readonly sessionId: string
  readonly collapseId: string
  readonly summary: string
  readonly firstArchivedUuid: string
  readonly lastArchivedUuid: string
}

export interface SubagentMeta {
  readonly id: string
  readonly sessionId: string
  readonly agentType?: string
  readonly description?: string
  readonly totalTokens?: number
  readonly totalTools?: number
  readonly durationMs?: number
  readonly model?: string
}

export interface FileChange {
  readonly sessionId: string
  readonly messageId?: string
  readonly filePath: string
  readonly operation: 'read' | 'write' | 'edit' | 'create'
  readonly timestamp: string
}
