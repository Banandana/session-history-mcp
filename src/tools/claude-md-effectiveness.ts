import { container } from 'tsyringe'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { TOKENS } from '../container/tokens'
import type { FreshnessGuard } from '../services/freshness-guard'
import type { ProjectResolver } from '../services/project-resolver'
import type { ResponseFormatter } from '../services/response-formatter'
import type { DatabaseConnection } from '../infrastructure/database'

/**
 * Measures the effect of CLAUDE.md edits on subsequent session quality.
 *
 * Rationale: CLAUDE.md is the agent's persistent instruction surface. When the
 * user edits it — typically in response to friction — the change should make
 * future sessions smoother. This tool detects edit events from the
 * `file_changes` table (sessions that modified a CLAUDE.md file) and compares
 * the aggregate quality metrics of the N sessions before vs. N sessions after
 * each event in the same project.
 *
 * The detection uses `file_changes` rather than git log so it works on
 * untracked projects and captures only edits made *through* Claude Code
 * (edits in another editor are excluded by design — the interesting question
 * is whether the agent's own self-corrections worked).
 */

interface SessionRow {
  readonly id: string
  readonly started_at: string | null
  readonly error_count: number | null
  readonly correction_count: number | null
  readonly cost_usd: number | null
  readonly duration_minutes: number | null
  readonly total_turns: number | null
}

interface WindowMetrics {
  readonly n: number
  readonly avgErrors: number
  readonly avgCorrections: number
  readonly avgCostUsd: number | null
  readonly avgDurationMin: number
  readonly avgTurns: number
}

function avg(values: readonly number[]): number {
  if (values.length === 0) return 0
  return values.reduce((a, b) => a + b, 0) / values.length
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function computeWindow(sessions: readonly SessionRow[]): WindowMetrics {
  const errors = sessions.map(s => s.error_count ?? 0)
  const corrections = sessions.map(s => s.correction_count ?? 0)
  const durations = sessions.map(s => s.duration_minutes ?? 0)
  const turns = sessions.map(s => s.total_turns ?? 0)
  const costs = sessions
    .map(s => s.cost_usd)
    .filter((c): c is number => c != null)

  return {
    n: sessions.length,
    avgErrors: round2(avg(errors)),
    avgCorrections: round2(avg(corrections)),
    avgCostUsd: costs.length > 0 ? round2(avg(costs)) : null,
    avgDurationMin: round2(avg(durations)),
    avgTurns: round2(avg(turns)),
  }
}

function computeDelta(
  before: WindowMetrics,
  after: WindowMetrics,
): Record<string, number | null> {
  const costDelta =
    before.avgCostUsd != null && after.avgCostUsd != null
      ? round2(after.avgCostUsd - before.avgCostUsd)
      : null
  return {
    errors: round2(after.avgErrors - before.avgErrors),
    corrections: round2(after.avgCorrections - before.avgCorrections),
    costUsd: costDelta,
    durationMin: round2(after.avgDurationMin - before.avgDurationMin),
    turns: round2(after.avgTurns - before.avgTurns),
  }
}

export function registerClaudeMdEffectiveness(server: McpServer): void {
  server.tool(
    'claude_md_effectiveness',
    'Measure whether CLAUDE.md edits actually reduced friction. Detects edit events via the file_changes table and compares the N sessions before vs. after each event. Returns metric deltas (errors, corrections, cost, duration, turns) so the user can see whether a CLAUDE.md change had the intended effect.',
    {
      project: z.string().optional().describe('Project slug to analyze'),
      path: z.string().optional().describe('Resolve project from filesystem path'),
      windowSize: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe('Number of sessions to average before and after each edit event (default 10)'),
    },
    async (params) => {
      const freshnessGuard = container.resolve<FreshnessGuard>(TOKENS.FreshnessGuard)
      const projectResolver = container.resolve<ProjectResolver>(TOKENS.ProjectResolver)
      const formatter = container.resolve<ResponseFormatter>(TOKENS.ResponseFormatter)
      const dbConn = container.resolve<DatabaseConnection>(TOKENS.Database)
      const db = dbConn.get()

      const freshness = await freshnessGuard.ensureFresh()

      const projectSlug = await projectResolver.resolveProjectFilter({
        project: params.project,
        path: params.path,
      })

      if (!projectSlug) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                { error: 'project or path is required to scope the analysis' },
                null,
                2,
              ),
            },
          ],
        }
      }

      const windowSize = params.windowSize ?? 10

      // All sessions for the project, ordered chronologically. We keep the
      // full list in memory because the window calculation needs random
      // access around each event index — the row count per project is small
      // (hundreds at most), so this is cheap.
      const sessions = db
        .prepare(
          `SELECT id, started_at, error_count, correction_count, cost_usd,
                  duration_minutes, total_turns
           FROM sessions
           WHERE project_slug = ? AND started_at IS NOT NULL
           ORDER BY started_at ASC`,
        )
        .all(projectSlug) as SessionRow[]

      if (sessions.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  project: projectSlug,
                  events: [],
                  note: 'No sessions found for this project',
                },
                null,
                2,
              ),
            },
          ],
        }
      }

      const sessionIndex = new Map<string, number>()
      sessions.forEach((s, i) => sessionIndex.set(s.id, i))

      // Detect edit events: distinct sessions that modified a CLAUDE.md file.
      // We match on the basename so edits to project-level CLAUDE.md, global
      // ~/.claude/CLAUDE.md, and subdirectory CLAUDE.md files all count.
      const editRows = db
        .prepare(
          `SELECT DISTINCT fc.session_id, MIN(fc.timestamp) AS first_edit
           FROM file_changes fc
           JOIN sessions s ON s.id = fc.session_id
           WHERE s.project_slug = ?
             AND (fc.file_path LIKE '%CLAUDE.md' OR fc.file_path LIKE '%claude.md')
             AND fc.operation IN ('write', 'edit', 'create')
           GROUP BY fc.session_id
           ORDER BY first_edit ASC`,
        )
        .all(projectSlug) as Array<{ session_id: string; first_edit: string | null }>

      const events = editRows
        .map(row => {
          const idx = sessionIndex.get(row.session_id)
          if (idx == null) return null

          const editSession = sessions[idx]
          // Before window = sessions strictly before the edit (exclusive).
          const beforeStart = Math.max(0, idx - windowSize)
          const before = sessions.slice(beforeStart, idx)
          // After window = sessions strictly after the edit (exclusive), so
          // the edit session itself doesn't double-count.
          const afterEnd = Math.min(sessions.length, idx + 1 + windowSize)
          const after = sessions.slice(idx + 1, afterEnd)

          // Skip events with no after-window — they can't tell us anything
          // yet and would produce zero deltas that look misleadingly good.
          if (after.length === 0) return null

          const beforeMetrics = computeWindow(before)
          const afterMetrics = computeWindow(after)

          return {
            sessionId: editSession.id,
            timestamp: editSession.started_at,
            before: beforeMetrics,
            after: afterMetrics,
            delta: computeDelta(beforeMetrics, afterMetrics),
          }
        })
        .filter((e): e is NonNullable<typeof e> => e !== null)

      const meta = formatter.formatMeta(freshness)
      const response = formatter.format(
        {
          project: projectSlug,
          windowSize,
          totalSessions: sessions.length,
          eventCount: events.length,
          events,
        },
        meta,
      )

      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(response, null, 2) },
        ],
      }
    },
  )
}
