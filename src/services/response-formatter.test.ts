import { describe, it, expect } from 'vitest'
import { ResponseFormatter } from './response-formatter'
import type { ResponseMeta, PaginationResult } from '../types'

const sampleMeta: ResponseMeta = {
  indexedAt: '2026-01-01T00:00:00Z',
  sessionCount: 5,
  staleSessions: 1,
  syncDurationMs: 42,
}

const samplePagination: PaginationResult = {
  cursor: 'abc123',
  hasMore: true,
  totalEstimate: 100,
}

describe('ResponseFormatter', () => {
  const formatter = new ResponseFormatter()

  it('formats data with meta', () => {
    const data = { sessions: ['session-1', 'session-2'] }
    const result = formatter.format(data, sampleMeta)

    expect(result.data).toEqual(data)
    expect(result.meta).toEqual(sampleMeta)
    expect(result.pagination).toBeUndefined()
  })

  it('includes pagination when provided', () => {
    const data = { items: [1, 2, 3] }
    const result = formatter.format(data, sampleMeta, samplePagination)

    expect(result.data).toEqual(data)
    expect(result.meta).toEqual(sampleMeta)
    expect(result.pagination).toEqual(samplePagination)
  })

  it('omits pagination when not provided', () => {
    const data = 'some string data'
    const result = formatter.format(data, sampleMeta)

    expect('pagination' in result).toBe(false)
  })

  it('formatMeta maps freshness fields to ResponseMeta', () => {
    const freshness = {
      syncDurationMs: 123,
      indexedAt: '2026-03-30T10:00:00Z',
      sessionCount: 10,
      staleSessions: 2,
    }

    const meta = formatter.formatMeta(freshness)

    expect(meta.syncDurationMs).toBe(123)
    expect(meta.indexedAt).toBe('2026-03-30T10:00:00Z')
    expect(meta.sessionCount).toBe(10)
    expect(meta.staleSessions).toBe(2)
  })

  it('works with null/undefined data', () => {
    const result = formatter.format(null, sampleMeta)
    expect(result.data).toBeNull()
    expect(result.meta).toEqual(sampleMeta)
  })

  it('preserves generic type information (number data)', () => {
    const result = formatter.format(42, sampleMeta)
    expect(result.data).toBe(42)
  })
})
