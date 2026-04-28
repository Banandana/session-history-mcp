import type { ParamNormalizer } from '../../types/invocation-log'
import { normalizeAnalyze } from './analyze'
import { normalizeContextAudit } from './context-audit'
import { normalizeClaudeMdEffectiveness } from './claude-md-effectiveness'
import { normalizeSearch, normalizeSemanticSearch } from './search'
import { normalizeGetChanges } from './get-changes'
import { normalizeDeepAnalyze } from './deep-analyze'
import { normalizeQueryTurns } from './query-turns'

/**
 * Registry of param normalizers — one per audit-style MCP tool.
 *
 * Tools NOT in this registry are still logged to `tool_invocations` (raw)
 * but skip the `audit_watermarks` UPSERT. This is the cleanest opt-out for
 * lookup-style tools (list_projects, get_session, get_turns, etc.) that
 * don't have a meaningful "last audit" semantic.
 */
export const PARAM_NORMALIZERS: Record<string, ParamNormalizer> = {
  analyze: normalizeAnalyze,
  context_audit: normalizeContextAudit,
  claude_md_effectiveness: normalizeClaudeMdEffectiveness,
  search: normalizeSearch,
  semantic_search: normalizeSemanticSearch,
  get_changes: normalizeGetChanges,
  deep_analyze: normalizeDeepAnalyze,
  query_turns: normalizeQueryTurns,
}

export function getNormalizer(toolName: string): ParamNormalizer | undefined {
  return PARAM_NORMALIZERS[toolName]
}

/**
 * Tools that should NOT appear in `get_project.recentAudits` even if logged.
 * These are either too noisy (called every navigation) or self-referential.
 */
export const RECENT_AUDITS_DENYLIST = new Set<string>([
  'get_audit_history',
  'list_projects',
  'get_project',
  'list_sessions',
  'get_session',
  'get_conversation',
  'get_turns',
  'get_memory',
])
