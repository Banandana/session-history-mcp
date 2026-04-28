import type { ParamNormalizer } from '../../types/invocation-log'

/** Audit identity = (project, windowSize). */
export const normalizeClaudeMdEffectiveness: ParamNormalizer = (input) => {
  const projectPath = pickProject(input)
  return {
    shape: {
      tool: 'claude_md_effectiveness',
      project: projectPath ?? null,
      hasWindowSize: input.windowSize != null,
    },
    projectPath,
  }
}

function pickProject(input: Record<string, unknown>): string | undefined {
  if (typeof input.project === 'string' && input.project.length > 0) return input.project
  if (typeof input.path === 'string' && input.path.length > 0) return input.path
  return undefined
}
