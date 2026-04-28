import type { ParamNormalizer } from '../../types/invocation-log'

/**
 * Audit identity = (metric, project, set of bounded filters).
 *
 * Per the "shape, not time anchor" rule, the from/to dates and numeric
 * threshold values do not enter the hash — only their presence does.
 */
export const normalizeContextAudit: ParamNormalizer = (input) => {
  const metric = typeof input.metric === 'string' ? input.metric : null
  if (!metric) return null

  const projectPath = pickProject(input)
  const filtersPresent: Record<string, boolean> = {
    minTokens: input.minTokens != null,
    maxTokens: input.maxTokens != null,
    minCost: input.minCost != null,
    maxCost: input.maxCost != null,
    minCacheHitRatio: input.minCacheHitRatio != null,
    maxCacheHitRatio: input.maxCacheHitRatio != null,
    modelFilter: typeof input.modelFilter === 'string' && input.modelFilter.length > 0,
  }
  const hasFrom = typeof input.from === 'string' && input.from.length > 0
  const hasTo = typeof input.to === 'string' && input.to.length > 0
  const temporalKind = hasFrom || hasTo ? 'pinned_range' : 'all_time'

  return {
    shape: {
      tool: 'context_audit',
      metric,
      project: projectPath ?? null,
      groupBy: typeof input.groupBy === 'string' ? input.groupBy : null,
      filtersPresent,
      temporal: { kind: temporalKind },
    },
    projectPath,
  }
}

function pickProject(input: Record<string, unknown>): string | undefined {
  if (typeof input.project === 'string' && input.project.length > 0) return input.project
  if (typeof input.path === 'string' && input.path.length > 0) return input.path
  return undefined
}
