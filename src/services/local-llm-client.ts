import type { ChatCompletionRequest, ChatCompletionResponse, ChatMessage } from '../types'
import { httpPost } from '../infrastructure/http-client'

export class LocalLlmClient {
  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
  ) {}

  async summarize(content: string, maxTokens: number = 500): Promise<string> {
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: 'Summarize the following conversation excerpt concisely. Focus on: what was attempted, what succeeded, what failed, and what the user corrected. Be specific about tool names and file paths. Keep it under ' + maxTokens + ' tokens.',
      },
      { role: 'user', content },
    ]

    const request: ChatCompletionRequest = {
      model: this.model,
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
