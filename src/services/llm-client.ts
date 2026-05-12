import type { ChatCompletionRequest, ChatCompletionResponse, ChatMessage } from '../types'
import { httpPost } from '../infrastructure/http-client'

/**
 * Common interface for LLM backends used for summarization and analysis.
 */
export interface LlmClient {
  summarize(content: string, maxTokens?: number): Promise<string>
  analyze(systemPrompt: string, content: string, maxTokens?: number): Promise<string>
  isAvailable(): Promise<boolean>
  readonly label: string
}

/**
 * Optional embeddings interface — backends that support vector embeddings
 * implement this. Batch is passed as an array because most providers are
 * substantially cheaper/faster in batch mode.
 */
export interface EmbeddingClient {
  embed(inputs: readonly string[]): Promise<readonly (readonly number[])[]>
  readonly embeddingModel: string
  readonly embeddingDim: number
}

interface EmbeddingsResponse {
  readonly data: readonly { readonly embedding: readonly number[] }[]
}

/**
 * OpenAI-compatible API client (local vLLM, ollama, etc.)
 *
 * When an `embeddingModel` is supplied the client also implements
 * EmbeddingClient against the /v1/embeddings endpoint.
 */
export class OpenAiLlmClient implements LlmClient, EmbeddingClient {
  readonly label: string
  readonly embeddingModel: string
  readonly embeddingDim: number
  private readonly embeddingBaseUrl: string

  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    options?: {
      readonly embeddingModel?: string
      readonly embeddingDim?: number
      readonly embeddingBaseUrl?: string
    },
  ) {
    this.label = `openai-compat:${model}`
    this.embeddingModel = options?.embeddingModel ?? ''
    this.embeddingDim = options?.embeddingDim ?? 1024
    this.embeddingBaseUrl = options?.embeddingBaseUrl ?? baseUrl
  }

  async embed(inputs: readonly string[]): Promise<readonly (readonly number[])[]> {
    if (!this.embeddingModel) {
      throw new Error('OpenAiLlmClient: embeddingModel not configured')
    }
    if (inputs.length === 0) return []

    const response = await httpPost<
      { model: string; input: readonly string[] },
      EmbeddingsResponse
    >(
      `${this.embeddingBaseUrl}/embeddings`,
      { model: this.embeddingModel, input: inputs },
      120_000,
    )
    return response.data.data.map(d => d.embedding)
  }

  async summarize(content: string, maxTokens: number = 500): Promise<string> {
    return this.analyze(
      'Summarize the following conversation excerpt concisely. Focus on: what was attempted, what succeeded, what failed, and what the user corrected. Be specific about tool names and file paths. Keep it under ' + maxTokens + ' tokens.',
      content,
      maxTokens,
    )
  }

  async analyze(systemPrompt: string, content: string, maxTokens: number = 4096): Promise<string> {
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
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
      120_000,
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

/**
 * Build an LLM client from environment. Local OpenAI-compatible only.
 */
export function createLlmClient(localUrl: string, localModel: string): OpenAiLlmClient {
  return new OpenAiLlmClient(localUrl, localModel)
}
