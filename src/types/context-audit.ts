// src/types/context-audit.ts
import type { DateRange } from './common'

export type ContextAuditMetric =
  | 'cost_breakdown'
  | 'token_attribution'
  | 'context_utilization'
  | 'cache_analysis'
  | 'collapse_analysis'
  | 'session_profile'

export type ContextAuditDetail = 'summary' | 'full'
export type TemporalGrouping = 'day' | 'week' | 'month'

export interface ContextAuditFilters {
  readonly projectSlug?: string | undefined
  readonly dateRange?: DateRange | undefined
  readonly minTokens?: number | undefined
  readonly maxTokens?: number | undefined
  readonly minCost?: number | undefined
  readonly maxCost?: number | undefined
  readonly minCacheHitRatio?: number | undefined
  readonly maxCacheHitRatio?: number | undefined
  readonly modelFilter?: string | undefined
}

export interface ContextAuditOptions {
  readonly metric: ContextAuditMetric
  readonly detail: ContextAuditDetail
  readonly groupBy?: TemporalGrouping | undefined
  readonly filters?: ContextAuditFilters | undefined
  readonly limit?: number | undefined
}

// Result types per metric

export interface SessionRef {
  readonly id: string
  readonly topic: string | null
  readonly costUsd: number | null
}

export interface CostBreakdownSummary {
  readonly totalCost: number
  readonly avgCost: number
  readonly sessionCount: number
  readonly minCostSession: SessionRef | null
  readonly maxCostSession: SessionRef | null
  readonly periods?: readonly CostPeriod[] | undefined
}

export interface CostPeriod {
  readonly period: string
  readonly totalCost: number
  readonly avgCost: number
  readonly sessionCount: number
}

export interface CostBreakdownFull {
  readonly sessions: readonly CostSessionDetail[]
}

export interface CostSessionDetail {
  readonly id: string
  readonly topic: string | null
  readonly startedAt: string | null
  readonly costUsd: number | null
  readonly totalTokens: number
  readonly cacheTokens: { readonly creation: number; readonly read: number }
}

export interface ToolAttribution {
  readonly toolName: string
  readonly totalTokens: number
  readonly messageCount: number
  readonly pctOfTotal: number
}

export interface TokenAttributionSummary {
  readonly tools: readonly ToolAttribution[]
  readonly totalToolResultTokens: number
}

export interface TokenAttributionFull {
  readonly sessions: readonly TokenAttributionSession[]
}

export interface TokenAttributionSession {
  readonly sessionId: string
  readonly topic: string | null
  readonly tools: readonly { readonly toolName: string; readonly resultTokens: number; readonly callTokens: number }[]
}

export interface ContextUtilizationSummary {
  readonly avgTotalTokens: number
  readonly medianTotalTokens: number
  readonly maxTotalTokens: number
  readonly avgPeakMessageTokens: number
  readonly sessionsWithCollapses: { readonly count: number; readonly percentage: number }
  readonly periods?: readonly { readonly period: string; readonly avgTotalTokens: number; readonly sessionCount: number; readonly collapseRate: number }[] | undefined
}

export interface ContextUtilizationFull {
  readonly sessions: readonly {
    readonly id: string
    readonly topic: string | null
    readonly totalTokens: number
    readonly peakMessageTokens: number
    readonly collapseCount: number
    readonly totalTurns: number
  }[]
}

export interface CacheAnalysisSummary {
  readonly overallHitRatio: number
  readonly avgHitRatio: number
  readonly totalCacheCreation: number
  readonly totalCacheRead: number
  readonly sessionCount: number
  readonly periods?: readonly { readonly period: string; readonly overallHitRatio: number; readonly avgHitRatio: number; readonly totalCacheCreation: number; readonly totalCacheRead: number }[] | undefined
}

export interface CacheAnalysisFull {
  readonly sessions: readonly {
    readonly id: string
    readonly topic: string | null
    readonly cacheHitRatio: number
    readonly cacheCreationTokens: number
    readonly cacheReadTokens: number
    readonly totalTokens: number
  }[]
}

export interface CollapseAnalysisSummary {
  readonly totalCollapses: number
  readonly avgCollapsesPerSession: number
  readonly sessionsWithCollapses: { readonly count: number; readonly percentage: number }
  readonly maxCollapseSession: SessionRef & { readonly collapseCount: number } | null
  readonly periods?: readonly { readonly period: string; readonly totalCollapses: number; readonly sessionCount: number; readonly avgPerSession: number }[] | undefined
}

export interface CollapseAnalysisFull {
  readonly sessions: readonly {
    readonly id: string
    readonly topic: string | null
    readonly totalTokens: number
    readonly collapses: readonly { readonly collapseId: string; readonly summary: string | null }[]
  }[]
}

export interface SessionProfileSummary {
  readonly totalCost: number
  readonly totalTokens: number
  readonly avgCacheHitRatio: number
  readonly totalCollapses: number
  readonly sessionCount: number
  readonly topExpensive: readonly SessionRef[]
  readonly topTokenHeavy: readonly (SessionRef & { readonly totalTokens: number })[]
  readonly topWorstCache: readonly (SessionRef & { readonly cacheHitRatio: number })[]
}

export interface SessionProfileFull {
  readonly sessions: readonly SessionProfileDetail[]
}

export interface SessionProfileDetail {
  readonly id: string
  readonly topic: string | null
  readonly startedAt: string | null
  readonly durationMinutes: number | null
  readonly costUsd: number | null
  readonly totalTokens: number
  readonly cacheTokens: { readonly creation: number; readonly read: number; readonly hitRatio: number }
  readonly collapseCount: number
  readonly totalTurns: number
  readonly peakMessageTokens: number
  readonly topTools: readonly { readonly toolName: string; readonly tokenCount: number }[]
  readonly modelsUsed: readonly string[]
}

export type ContextAuditResult =
  | CostBreakdownSummary | CostBreakdownFull
  | TokenAttributionSummary | TokenAttributionFull
  | ContextUtilizationSummary | ContextUtilizationFull
  | CacheAnalysisSummary | CacheAnalysisFull
  | CollapseAnalysisSummary | CollapseAnalysisFull
  | SessionProfileSummary | SessionProfileFull
