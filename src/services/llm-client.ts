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

interface ModelsResponse {
  readonly data: readonly { readonly id: string }[]
}

/**
 * OpenAI-compatible API client (SGLang, ollama, llama.cpp, etc.)
 *
 * The chat-completions `model` field is required by the OpenAI wire schema
 * but most single-model local servers ignore the value. We discover the
 * actual served model on first use via `/v1/models` and cache it, so the
 * caller doesn't have to keep an env var in sync with the running backend.
 *
 * When an `embeddingModel` is supplied the client also implements
 * EmbeddingClient against the /v1/embeddings endpoint.
 */
export class OpenAiLlmClient implements LlmClient, EmbeddingClient {
  readonly embeddingModel: string
  readonly embeddingDim: number
  private readonly embeddingBaseUrl: string
  private discoveredModel: string | null = null
  private discoveryPromise: Promise<string> | null = null

  constructor(
    private readonly baseUrl: string,
    private readonly modelFallback: string = 'local',
    options?: {
      readonly embeddingModel?: string
      readonly embeddingDim?: number
      readonly embeddingBaseUrl?: string
    },
  ) {
    this.embeddingModel = options?.embeddingModel ?? ''
    this.embeddingDim = options?.embeddingDim ?? 1024
    this.embeddingBaseUrl = options?.embeddingBaseUrl ?? baseUrl
  }

  get label(): string {
    return `openai-compat:${this.discoveredModel ?? this.modelFallback}`
  }

  /**
   * Discover the served model name once, lazily. Falls back to `modelFallback`
   * if `/v1/models` is unreachable or returns nothing — the chat-completions
   * call may still succeed since most local servers ignore the model field.
   */
  private async resolveModel(): Promise<string> {
    if (this.discoveredModel) return this.discoveredModel
    if (this.discoveryPromise) return this.discoveryPromise

    this.discoveryPromise = (async () => {
      try {
        const response = await fetch(`${this.baseUrl}/models`, {
          signal: AbortSignal.timeout(5000),
        })
        if (!response.ok) {
          // Clear the cached in-flight promise so the next call retries.
          // Only success caches; transient failures must not poison.
          this.discoveryPromise = null
          return this.modelFallback
        }
        const body = await response.json() as ModelsResponse
        const id = body.data[0]?.id
        if (typeof id === 'string' && id.length > 0) {
          this.discoveredModel = id
          return id
        }
      } catch {
        // discovery failed — fall through to the constructor fallback
      }
      this.discoveryPromise = null
      return this.modelFallback
    })()

    return this.discoveryPromise
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
      model: await this.resolveModel(),
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
 * The model field is discovered lazily from `/v1/models`; the second arg
 * is just the fallback label when discovery fails.
 */
export function createLlmClient(localUrl: string, modelFallback?: string): OpenAiLlmClient {
  return new OpenAiLlmClient(localUrl, modelFallback)
}
