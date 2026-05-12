export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant'
  readonly content: string
}

export interface ChatCompletionRequest {
  readonly model: string
  readonly messages: readonly ChatMessage[]
  readonly max_tokens?: number | undefined
  readonly temperature?: number | undefined
}

export interface ChatCompletionResponse {
  readonly id: string
  readonly choices: readonly {
    readonly message: {
      readonly role: string
      readonly content: string
    }
    readonly finish_reason: string
  }[]
  readonly usage: {
    readonly prompt_tokens: number
    readonly completion_tokens: number
    readonly total_tokens: number
  }
}
