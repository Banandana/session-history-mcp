import type { SubagentMeta } from '../../types'

/**
 * Pi has no subagent concept (no `agent-<id>.jsonl` siblings). This parser yields nothing.
 * Kept as a class for symmetry with the claude-code adapter shape.
 */
export class PiSubagentParser {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars, require-yield
  async *getSubagents(_sessionId: string): AsyncIterable<SubagentMeta> {
    return
  }
}
