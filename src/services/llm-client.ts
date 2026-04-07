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
 * OpenAI-compatible API client (local vLLM, ollama, etc.)
 */
export class OpenAiLlmClient implements LlmClient {
  readonly label: string

  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
  ) {
    this.label = `openai-compat:${model}`
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
 * Anthropic API (if key present) > local OpenAI-compatible > unavailable.
 */
export class FallbackLlmClient implements LlmClient {
  readonly label: string

  constructor(private readonly clients: readonly LlmClient[]) {
    this.label = clients.map(c => c.label).join(' > ')
  }

  private async resolve(): Promise<LlmClient | null> {
    for (const client of this.clients) {
      if (await client.isAvailable()) return client
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
 * Check whether LLM functionality is disabled via environment variable.
 * Set DISABLE_LLM=1 (or any truthy value) to prevent all LLM API calls.
 */
export function isLlmDisabled(): boolean {
  const val = process.env.DISABLE_LLM
  return val !== undefined && val !== '' && val !== '0' && val.toLowerCase() !== 'false'
}

/**
 * Build an LLM client stack from environment.
 * Priority: Anthropic API (ANTHROPIC_API_KEY) > local vLLM > none
 * Returns empty client stack if DISABLE_LLM is set.
 */
export function createLlmClient(localUrl: string, localModel: string): FallbackLlmClient {
  if (isLlmDisabled()) {
    return new FallbackLlmClient([])
  }

  const clients: LlmClient[] = []

  const anthropicKey = process.env.ANTHROPIC_API_KEY ?? process.env.FANTHROPIC_API_KEY
  if (anthropicKey) {
    clients.push(new AnthropicLlmClient(anthropicKey, 'claude-opus-4-6'))
  }

  clients.push(new OpenAiLlmClient(localUrl, localModel))

  return new FallbackLlmClient(clients)
}
