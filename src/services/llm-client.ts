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
 * Anthropic Messages API response shape.
 */
interface AnthropicResponse {
  readonly id: string
  readonly content: readonly { readonly type: string; readonly text?: string }[]
  readonly stop_reason: string
  readonly usage: {
    readonly input_tokens: number
    readonly output_tokens: number
  }
}

/**
 * Native Anthropic API client. Requires ANTHROPIC_API_KEY env var.
 */
export class AnthropicLlmClient implements LlmClient {
  readonly label: string

  constructor(
    private readonly apiKey: string,
    private readonly model: string = 'claude-opus-4-6',
  ) {
    this.label = `anthropic:${model}`
  }

  async summarize(content: string, maxTokens: number = 500): Promise<string> {
    return this.analyze(
      'Summarize the following conversation excerpt concisely. Focus on: what was attempted, what succeeded, what failed, and what the user corrected. Be specific about tool names and file paths.',
      content,
      maxTokens,
    )
  }

  async analyze(systemPrompt: string, content: string, maxTokens: number = 16384): Promise<string> {
    const body = {
      model: this.model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content }],
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 300_000) // 5min for large analyses

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (!response.ok) {
        const errText = await response.text()
        throw new Error(`Anthropic API ${response.status}: ${errText}`)
      }

      const data = await response.json() as AnthropicResponse
      return data.content
        .filter(block => block.type === 'text' && block.text)
        .map(block => block.text!)
        .join('\n')
    } finally {
      clearTimeout(timer)
    }
  }

  async isAvailable(): Promise<boolean> {
    return this.apiKey.length > 0
  }
}

/**
 * Tries multiple LLM backends in priority order.
 * Local vLLM (cheap) > Anthropic API (fallback).
 * deep_analyze bypasses this via getAnthropicClient() directly.
 */
export class FallbackLlmClient implements LlmClient {
  readonly label: string
  private activeClient: LlmClient | null = null

  constructor(private readonly clients: readonly LlmClient[]) {
    this.label = clients.map(c => c.label).join(' > ')
  }

  private async resolve(): Promise<LlmClient | null> {
    if (this.activeClient) return this.activeClient
    for (const client of this.clients) {
      if (await client.isAvailable()) {
        this.activeClient = client
        return client
      }
    }
    return null
  }

  async summarize(content: string, maxTokens?: number): Promise<string> {
    const client = await this.resolve()
    if (!client) throw new Error('No LLM backend available')
    return client.summarize(content, maxTokens)
  }

  async analyze(systemPrompt: string, content: string, maxTokens?: number): Promise<string> {
    const client = await this.resolve()
    if (!client) throw new Error('No LLM backend available')
    return client.analyze(systemPrompt, content, maxTokens)
  }

  async isAvailable(): Promise<boolean> {
    return (await this.resolve()) !== null
  }

  /**
   * Get the Anthropic client specifically, for expensive operations that
   * require Opus-class models. Returns null if no Anthropic key is configured.
   */
  getAnthropicClient(): AnthropicLlmClient | null {
    for (const client of this.clients) {
      if (client instanceof AnthropicLlmClient) return client
    }
    return null
  }
}

/**
 * Build an LLM client stack from environment.
 * Priority: local vLLM (cheap) > Anthropic API (fallback).
 * If no keys/endpoints configured, the client stack is simply empty.
 */
export function createLlmClient(localUrl: string, localModel: string): FallbackLlmClient {
  const clients: LlmClient[] = []

  clients.push(new OpenAiLlmClient(localUrl, localModel))

  const anthropicKey = process.env['ANTHROPIC_API_KEY'] ?? process.env['FANTHROPIC_API_KEY']
  if (anthropicKey) {
    clients.push(new AnthropicLlmClient(anthropicKey, 'claude-opus-4-6'))
  }

  return new FallbackLlmClient(clients)
}
