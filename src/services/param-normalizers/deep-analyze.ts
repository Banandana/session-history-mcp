import type { ParamNormalizer } from '../../types/invocation-log'

/**
 * Audit identity = (sessionId, focus). Re-running deep_analyze on the same
 * session with the same focus is a re-audit. Different session OR different
 * focus = different audit.
 */
export const normalizeDeepAnalyze: ParamNormalizer = (input) => {
  const sessionId = typeof input['sessionId'] === 'string' ? input['sessionId'] : ''
  if (!sessionId) return null
  const focus = typeof input['focus'] === 'string' && input['focus'].length > 0
    ? input['focus'].trim()
    : null
  return {
    shape: {
      tool: 'deep_analyze',
      sessionId,
      focus,
    },
    // sessionId isn't a project path; deep_analyze is session-scoped
    projectPath: undefined,
  }
}
