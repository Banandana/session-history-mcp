import type { ParamNormalizer } from '../../types/invocation-log'

/**
 * Audit identity for `search` and `semantic_search` is the literal query
 * text plus scoping (project, sessionId). The query text IS the audit subject
 * — running the same query later asks "what new matches exist."
 *
 * Date range is treated as a temporal anchor (kind only, not value), so an
 * agent that re-runs the query with a fresh `from` matches the same watermark.
 */
function normalizeQueryShape(toolName: 'search' | 'semantic_search', input: Record<string, unknown>) {
  const query = typeof input['query'] === 'string' ? input['query'].trim() : ''
  if (!query) return null

  const projectPath = pickProject(input)
  const sessionId = typeof input['sessionId'] === 'string' && input['sessionId'].length > 0
    ? input['sessionId']
    : null
  const hasFrom = typeof input['from'] === 'string' && input['from'].length > 0
  const hasTo = typeof input['to'] === 'string' && input['to'].length > 0
  const temporalKind = hasFrom || hasTo ? 'pinned_range' : 'all_time'

  return {
    shape: {
      tool: toolName,
      query,
      project: projectPath ?? null,
      sessionId,
      temporal: { kind: temporalKind },
    },
    projectPath,
  }
}

export const normalizeSearch: ParamNormalizer = (input) => normalizeQueryShape('search', input)
export const normalizeSemanticSearch: ParamNormalizer = (input) => normalizeQueryShape('semantic_search', input)

function pickProject(input: Record<string, unknown>): string | undefined {
  if (typeof input['project'] === 'string' && input['project'].length > 0) return input['project']
  if (typeof input['path'] === 'string' && input['path'].length > 0) return input['path']
  return undefined
}
