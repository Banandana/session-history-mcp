import type { ParamNormalizer } from '../../types/invocation-log'

/**
 * `query_turns` is hybrid: filter-style queries (toolNames, isError, isCorrection,
 * roles, textPattern) are audit-meaningful — "find me error turns matching X."
 * Pure scope queries (just sessionId or projectId, no filters) are lookups
 * and skip the watermark.
 *
 * timeRange and turnRange are treated as temporal anchors (kind only).
 */
export const normalizeQueryTurns: ParamNormalizer = (input) => {
  const toolNames = Array.isArray(input['toolNames']) ? [...input['toolNames'] as unknown[]].sort() : null
  const roles = Array.isArray(input['roles']) ? [...input['roles'] as unknown[]].sort() : null
  const textPattern = typeof input['textPattern'] === 'string' && input['textPattern'].length > 0
    ? input['textPattern'] : null
  const isError = typeof input['isError'] === 'boolean' ? input['isError'] : null
  const isCorrection = typeof input['isCorrection'] === 'boolean' ? input['isCorrection'] : null

  const hasFilter = toolNames !== null || roles !== null || textPattern !== null || isError !== null || isCorrection !== null
  if (!hasFilter) return null  // pure-scope lookup, skip watermark

  const projectId = typeof input['projectId'] === 'string' ? input['projectId'] : null
  const sessionId = typeof input['sessionId'] === 'string' ? input['sessionId'] : null

  const tr = isPlainObject(input['timeRange']) ? input['timeRange'] : {}
  const hasTimeRange = (typeof tr['after'] === 'string' && tr['after'].length > 0)
                    || (typeof tr['before'] === 'string' && tr['before'].length > 0)
  const hasTurnRange = isPlainObject(input['turnRange'])

  return {
    shape: {
      tool: 'query_turns',
      project: projectId,
      sessionId,
      filters: { toolNames, roles, textPattern, isError, isCorrection },
      temporal: {
        kind: hasTimeRange ? 'pinned_time_range'
            : hasTurnRange ? 'pinned_turn_range'
            : 'all',
      },
    },
    projectPath: projectId ?? undefined,
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
