import type { ToolResponse, ResponseMeta, PaginationResult } from '../types'

export class ResponseFormatter {
  format<T>(
    data: T,
    meta: ResponseMeta,
    pagination?: PaginationResult,
  ): ToolResponse<T> {
    return {
      data,
      ...(pagination ? { pagination } : {}),
      meta,
    }
  }

  formatMeta(freshness: {
    syncDurationMs: number
    indexedAt: string
    sessionCount: number
    staleSessions: number
  }): ResponseMeta {
    return {
      indexedAt: freshness.indexedAt,
      sessionCount: freshness.sessionCount,
      staleSessions: freshness.staleSessions,
      syncDurationMs: freshness.syncDurationMs,
    }
  }
}
