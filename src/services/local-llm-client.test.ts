import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LocalLlmClient } from './local-llm-client'

// Mock the http-client module
vi.mock('../infrastructure/http-client', () => ({
  httpPost: vi.fn(),
}))

import { httpPost } from '../infrastructure/http-client'

const mockHttpPost = vi.mocked(httpPost)

describe('LocalLlmClient', () => {
  let client: LocalLlmClient
  const baseUrl = 'http://10.1.10.20:30000/v1'
  const model = 'test-model'

  beforeEach(() => {
    client = new LocalLlmClient(baseUrl, model)
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('summarize', () => {
    it('sends correct request format (model, messages, max_tokens)', async () => {
      mockHttpPost.mockResolvedValueOnce({
        status: 200,
        data: {
          id: 'test-id',
          choices: [{ message: { role: 'assistant', content: 'Test summary' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        },
      })

      await client.summarize('Some content', 300)

      expect(mockHttpPost).toHaveBeenCalledOnce()
      const [url, requestBody, timeout] = mockHttpPost.mock.calls[0]

      expect(url).toBe(`${baseUrl}/chat/completions`)
      expect(requestBody).toMatchObject({
        model,
        messages: expect.arrayContaining([
          expect.objectContaining({ role: 'system' }),
          expect.objectContaining({ role: 'user', content: 'Some content' }),
        ]),
        max_tokens: 300,
        temperature: 0.3,
      })
      expect(timeout).toBe(60_000)
    })

    it('returns response content', async () => {
      const expectedSummary = 'This is the generated summary.'

      mockHttpPost.mockResolvedValueOnce({
        status: 200,
        data: {
          id: 'test-id',
          choices: [{ message: { role: 'assistant', content: expectedSummary }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        },
      })

      const result = await client.summarize('Content to summarize')
      expect(result).toBe(expectedSummary)
    })

    it('returns empty string when choices array is empty', async () => {
      mockHttpPost.mockResolvedValueOnce({
        status: 200,
        data: {
          id: 'test-id',
          choices: [],
          usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 },
        },
      })

      const result = await client.summarize('Content')
      expect(result).toBe('')
    })

    it('uses default maxTokens of 500', async () => {
      mockHttpPost.mockResolvedValueOnce({
        status: 200,
        data: {
          id: 'test-id',
          choices: [{ message: { role: 'assistant', content: 'Summary' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        },
      })

      await client.summarize('Content')

      const [, requestBody] = mockHttpPost.mock.calls[0]
      expect((requestBody as { max_tokens: number }).max_tokens).toBe(500)
    })

    it('handles timeout gracefully by propagating the error', async () => {
      mockHttpPost.mockRejectedValueOnce(new Error('Request timeout'))

      await expect(client.summarize('Content')).rejects.toThrow('Request timeout')
    })
  })

  describe('isAvailable', () => {
    it('returns true when server responds with ok', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({ ok: true })
      vi.stubGlobal('fetch', mockFetch)

      const result = await client.isAvailable()

      expect(result).toBe(true)
      expect(mockFetch).toHaveBeenCalledWith(`${baseUrl}/models`, expect.objectContaining({
        signal: expect.any(Object),
      }))
    })

    it('returns false when server responds with not ok', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({ ok: false })
      vi.stubGlobal('fetch', mockFetch)

      const result = await client.isAvailable()

      expect(result).toBe(false)
    })

    it('returns false when server is unreachable', async () => {
      const mockFetch = vi.fn().mockRejectedValueOnce(new Error('ECONNREFUSED'))
      vi.stubGlobal('fetch', mockFetch)

      const result = await client.isAvailable()

      expect(result).toBe(false)
    })

    it('returns false on timeout', async () => {
      const mockFetch = vi.fn().mockRejectedValueOnce(new DOMException('The operation was aborted', 'AbortError'))
      vi.stubGlobal('fetch', mockFetch)

      const result = await client.isAvailable()

      expect(result).toBe(false)
    })
  })
})
