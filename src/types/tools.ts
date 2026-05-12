import type { DateRange, PaginationParams } from './common'
import type { MessageRole } from './session'

export type AnalyzeMetric = 'errors' | 'corrections' | 'tool_failures' | 'costly_sessions' | 'frequent_files' | 'cache_efficiency' | 'model_usage'
export type ConversationWindow = 'start' | 'end' | 'errors' | 'corrections'

export interface ProjectFilter {
  readonly project?: string | undefined
  readonly path?: string | undefined
}

export interface ListProjectsParams {
  readonly sortBy?: 'recent' | 'sessions' | 'name'
  readonly limit?: number | undefined
}

export interface GetProjectParams extends ProjectFilter {
  readonly detail?: 'summary' | 'full'
}

export interface ListSessionsParams extends ProjectFilter, PaginationParams {
  readonly branch?: string | undefined
  readonly dateRange?: DateRange | undefined
}

export interface GetSessionParams {
  readonly sessionId: string
  readonly detail?: 'summary' | 'metadata' | 'full'
}

export interface GetConversationParams extends PaginationParams {
  readonly sessionId: string
  readonly maxTokens?: number | undefined
  readonly roles?: readonly MessageRole[] | undefined
  readonly includeToolResults?: boolean | undefined
  readonly window?: ConversationWindow | undefined
}

export interface SearchParams extends ProjectFilter, PaginationParams {
  readonly query: string
  readonly dateRange?: DateRange | undefined
  readonly sessionId?: string | undefined
  readonly maxResults?: number | undefined
}

export interface GetChangesParams extends ProjectFilter, PaginationParams {
  readonly sessionId?: string | undefined
  readonly filePath?: string | undefined
  readonly operation?: string | undefined
}

export interface GetMemoryParams extends ProjectFilter {
  readonly type?: 'user' | 'feedback' | 'project' | 'reference'
  readonly search?: string | undefined
}

export interface AnalyzeParams extends ProjectFilter {
  readonly metric: AnalyzeMetric
  readonly dateRange?: DateRange | undefined
  readonly limit?: number | undefined
}
