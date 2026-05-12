import type { ChatCompletionRequest, ChatCompletionResponse, ChatMessage } from '../types'
import { httpPost } from '../infrastructure/http-client'

interface ModelsResponse {
  readonly data: readonly { readonly id: string }[]
}

export class LocalLlmClient {
  private discoveredModel: string | null = null
  private discoveryPromise: Promise<string> | null = null

  constructor(
    private readonly baseUrl: string,
    private readonly modelFallback: string = 'local',
  ) {}

  private async resolveModel(): Promise<string> {
    if (this.discoveredModel) return this.discoveredModel
    if (this.discoveryPromise) return this.discoveryPromise
    this.discoveryPromise = (async () => {
      try {
        const response = await fetch(`${this.baseUrl}/models`, {
          signal: AbortSignal.timeout(5000),
        })
        if (!response.ok) return this.modelFallback
        const body = await response.json() as ModelsResponse
        const id = body.data[0]?.id
        if (typeof id === 'string' && id.length > 0) {
          this.discoveredModel = id
          return id
        }
      } catch { /* fall through */ }
      return this.modelFallback
    })()
    return this.discoveryPromise
  }

  async summarize(content: string, maxTokens: number = 500): Promise<string> {
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: 'Summarize the following conversation excerpt concisely. Focus on: what was attempted, what succeeded, what failed, and what the user corrected. Be specific about tool names and file paths. Keep it under ' + maxTokens + ' tokens.',
      },
      { role: 'user', content },
    ]

    const request: ChatCompletionRequest = {
      model: await this.resolveModel(),
      messages,
      max_tokens: maxTokens,
      temperature: 0.3,
    }

    const response = await httpPost<ChatCompletionRequest, ChatCompletionResponse>(
      `${this.baseUrl}/chat/completions`,
      request,
      60_000, // 60s timeout for LLM
    )

    return response.data.choices[0]?.message.content ?? ''
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        signal: AbortSignal.timeout(5000),
      })
      return response.ok
    } catch {
      return false
    }
  }
}
