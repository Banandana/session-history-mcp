export interface PaginatedResult<T> {
  readonly items: readonly T[]
  readonly cursor?: string | undefined
  readonly hasMore: boolean
  readonly totalEstimate: number
}

export class PaginationManager {
  private readonly defaultLimit = 50

  paginate<T>(
    items: readonly T[],
    params: { cursor?: string | undefined; limit?: number | undefined; total?: number | undefined }
  ): PaginatedResult<T> {
    const offset = params.cursor ? this.decodeCursor(params.cursor) : 0
    const limit = params.limit ?? this.defaultLimit
    const page = items.slice(offset, offset + limit)
    // If caller supplies a real total (e.g., from a COUNT query), trust it.
    // Otherwise fall back to items.length — which is only accurate when the
    // caller passed the full result set.
    const totalEstimate = params.total ?? items.length
    const hasMore = params.total !== undefined
      ? offset + page.length < params.total
      : offset + limit < items.length
    const nextCursor = hasMore ? this.encodeCursor(offset + page.length) : undefined

    return {
      items: page,
      cursor: nextCursor,
      hasMore,
      totalEstimate,
    }
  }

  encodeCursor(offset: number): string {
    return Buffer.from(JSON.stringify({ o: offset })).toString('base64url')
  }

  decodeCursor(cursor: string): number {
    try {
      const data = JSON.parse(Buffer.from(cursor, 'base64url').toString())
      return typeof data?.o === 'number' ? data.o : 0
    } catch {
      return 0
    }
  }
}
