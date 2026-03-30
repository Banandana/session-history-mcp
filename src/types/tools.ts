import type { DateRange, PaginationParams } from './common'
import type { MessageRole } from './session'

export type AnalyzeMetric = 'errors' | 'corrections' | 'tool_failures' | 'costly_sessions' | 'frequent_files'
export type ConversationWindow = 'start' | 'end' | 'errors' | 'corrections'

export interface ProjectFilter {
  readonly project?: string
  readonly path?: string
}

export interface ListProjectsParams {
  readonly sortBy?: 'recent' | 'sessions' | 'name'
  readonly limit?: number
}

export interface GetProjectParams extends ProjectFilter {
  readonly detail?: 'summary' | 'full'
}

export interface ListSessionsParams extends ProjectFilter, PaginationParams {
  readonly branch?: string
  readonly dateRange?: DateRange
}

export interface GetSessionParams {
  readonly sessionId: string
  readonly detail?: 'summary' | 'metadata' | 'full'
}

export interface GetConversationParams extends PaginationParams {
  readonly sessionId: string
  readonly maxTokens?: number
  readonly roles?: readonly MessageRole[]
  readonly includeToolResults?: boolean
  readonly window?: ConversationWindow
}

export interface SearchParams extends ProjectFilter, PaginationParams {
  readonly query: string
  readonly dateRange?: DateRange
  readonly sessionId?: string
  readonly maxResults?: number
}

export interface GetChangesParams extends ProjectFilter, PaginationParams {
  readonly sessionId?: string
  readonly filePath?: string
  readonly operation?: string
}

export interface GetMemoryParams extends ProjectFilter {
  readonly type?: 'user' | 'feedback' | 'project' | 'reference'
  readonly search?: string
}

export interface AnalyzeParams extends ProjectFilter {
  readonly metric: AnalyzeMetric
  readonly dateRange?: DateRange
  readonly limit?: number
}
