import type { ParamNormalizer } from '../../types/invocation-log'

/**
 * Normalizer for the `analyze` tool.
 *
 * Audit identity is (metric, project). The `from`/`to` date range is treated
 * as a temporal anchor — its presence shapes the canonical form (rolling
 * vs pinned), but the actual values do not, so re-running with a fresh date
 * range matches the same watermark.
 *
 * `limit` is purely presentational and ignored.
 */
export const normalizeAnalyze: ParamNormalizer = (input) => {
  const metric = typeof input.metric === 'string' ? input.metric : null
  if (!metric) return null

  const projectPath = pickProjectSlug(input)
  const hasFrom = typeof input.from === 'string' && input.from.length > 0
  const hasTo = typeof input.to === 'string' && input.to.length > 0
  const temporalKind = hasFrom || hasTo ? 'pinned_range' : 'all_time'

  return {
    shape: {
      tool: 'analyze',
      metric,
      project: projectPath ?? null,
      temporal: { kind: temporalKind },
    },
    projectPath,
  }
}

function pickProjectSlug(input: Record<string, unknown>): string | undefined {
  if (typeof input.project === 'string' && input.project.length > 0) return input.project
  // `path` resolves to a slug at call time; we don't have the registry here.
  // If only `path` is provided, fall back to using the path as the project key.
  // This means audits keyed by path and audits keyed by slug won't collide,
  // which is conservative — the worst case is two watermark rows for the same
  // project, which is acceptable for v1.
  if (typeof input.path === 'string' && input.path.length > 0) return input.path
  return undefined
}
