export interface PaginatedResult<T> {
  readonly items: readonly T[]
  readonly cursor?: string
  readonly hasMore: boolean
  readonly totalEstimate: number
}

export class PaginationManager {
  private readonly defaultLimit = 50

  paginate<T>(
    items: readonly T[],
    params: { cursor?: string; limit?: number }
  ): PaginatedResult<T> {
    const offset = params.cursor ? this.decodeCursor(params.cursor) : 0
    const limit = params.limit ?? this.defaultLimit
    const page = items.slice(offset, offset + limit)
    const hasMore = offset + limit < items.length
    const nextCursor = hasMore ? this.encodeCursor(offset + limit) : undefined

    return {
      items: page,
      cursor: nextCursor,
      hasMore,
      totalEstimate: items.length,
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
