import type { ParamNormalizer } from '../../types/invocation-log'

/**
 * Audit identity for `get_changes` is (project, filePath, operation).
 * Audit-style use case: "what files changed in this project recently."
 * `sessionId` filters scope it to a single session — that's a lookup,
 * not an audit, so we skip the watermark when sessionId is set.
 */
export const normalizeGetChanges: ParamNormalizer = (input) => {
  if (typeof input.sessionId === 'string' && input.sessionId.length > 0) return null

  const projectPath = pickProject(input)
  return {
    shape: {
      tool: 'get_changes',
      project: projectPath ?? null,
      filePath: typeof input.filePath === 'string' ? input.filePath : null,
      operation: typeof input.operation === 'string' ? input.operation : null,
    },
    projectPath,
  }
}

function pickProject(input: Record<string, unknown>): string | undefined {
  if (typeof input.project === 'string' && input.project.length > 0) return input.project
  if (typeof input.path === 'string' && input.path.length > 0) return input.path
  return undefined
}
