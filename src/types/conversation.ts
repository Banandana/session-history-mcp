import type { ContentBlock, MessageRole, TokenUsage } from './session'

export interface Phase {
  readonly turnRange: { readonly from: number; readonly to: number }
  readonly description: string
  readonly toolNames: readonly string[]
  readonly errorCount: number
  readonly turnCount: number
}

export interface TurnReference {
  readonly sessionId: string
  readonly turnIndex: number
  readonly turnId: string
  readonly timestamp: string
  readonly role: MessageRole
  readonly summary: string
  readonly toolNames: readonly string[]
  readonly isError: boolean
  readonly isCorrection: boolean
  readonly matchContext?: string | undefined
}

export interface ExpandedTurn {
  readonly turnIndex: number
  readonly turnId: string
  readonly role: MessageRole
  readonly timestamp: string
  readonly contentBlocks: readonly ContentBlock[]
  readonly toolNames: readonly string[]
  readonly isError: boolean
  readonly isCorrection: boolean
  readonly hasThinking: boolean
  readonly model?: string | undefined
  readonly tokenUsage?: TokenUsage | undefined
  readonly cacheTokens?: {
    readonly creation: number
    readonly read: number
  } | undefined
}
