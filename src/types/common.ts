export interface DateRange {
  readonly from?: string | undefined  // ISO 8601
  readonly to?: string | undefined    // ISO 8601
}

export interface PaginationParams {
  readonly cursor?: string | undefined
  readonly limit?: number | undefined
}

export interface PaginationResult {
  readonly cursor: string
  readonly hasMore: boolean
  readonly totalEstimate: number
}

export interface ResponseMeta {
  readonly indexedAt: string
  readonly sessionCount: number
  readonly staleSessions: number
  readonly syncDurationMs: number
}

export interface ToolResponse<T> {
  readonly data: T
  readonly pagination?: PaginationResult | undefined
  readonly meta: ResponseMeta
}
