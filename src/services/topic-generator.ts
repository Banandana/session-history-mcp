interface TopicInput {
  readonly firstUserMessage?: string | undefined
  readonly secondUserMessage?: string | undefined
  readonly userMessages?: readonly string[]
  readonly toolCounts: Record<string, number>
  readonly errorCount: number
}

interface CategoryRule {
  readonly label: string
  readonly pattern: RegExp
}

const CATEGORY_RULES: readonly CategoryRule[] = [
  { label: 'schematic work', pattern: /^mcp__kicad__/ },
  { label: 'component search', pattern: /^mcp__pcbparts__|^mcp__mouser__|^mcp__jlcpcb/ },
  { label: 'circuit simulation', pattern: /^mcp__spicebridge__/ },
  { label: 'code exploration', pattern: /^Grep$|^Read$|^Glob$/ },
  { label: 'code changes', pattern: /^Edit$|^Write$/ },
  { label: 'shell operations', pattern: /^Bash$/ },
  { label: 'research', pattern: /^WebFetch$|^WebSearch$/ },
  { label: 'agent delegation', pattern: /^Agent$|^Task/ },
] as const

const MAX_MESSAGE_LENGTH = 60
const ERROR_THRESHOLD = 5
const MAX_CATEGORIES = 2
const SEPARATOR = ' — '

function sanitizeMessage(message: string): string {
  // Strip XML/HTML tags (command tags, system reminders, etc.)
  let cleaned = message.replace(/<[^>]+>/g, '').trim()
  // Collapse whitespace
  cleaned = cleaned.replace(/\s+/g, ' ')
  return cleaned
}

function truncateMessage(message: string): string {
  const clean = sanitizeMessage(message)
  if (clean.length <= MAX_MESSAGE_LENGTH) {
    return clean
  }
  // Truncate on word boundary
  const truncated = clean.slice(0, MAX_MESSAGE_LENGTH)
  const lastSpace = truncated.lastIndexOf(' ')
  if (lastSpace > MAX_MESSAGE_LENGTH * 0.5) {
    return truncated.slice(0, lastSpace) + '...'
  }
  return truncated + '...'
}

function computeCategoryCounts(toolCounts: Record<string, number>): Map<string, number> {
  const totals = new Map<string, number>()

  for (const [toolName, count] of Object.entries(toolCounts)) {
    for (const rule of CATEGORY_RULES) {
      if (rule.pattern.test(toolName)) {
        totals.set(rule.label, (totals.get(rule.label) ?? 0) + count)
        break
      }
    }
  }

  return totals
}

function topCategories(categoryCounts: Map<string, number>): readonly string[] {
  return [...categoryCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_CATEGORIES)
    .map(([label]) => label)
}

function isNonIntentMessage(message: string): boolean {
  const clean = sanitizeMessage(message)
  // Slash commands: /clear, /mcp, etc.
  if (/^\/\w+/.test(clean) && clean.length < 30) return true
  // System injections that survive tag stripping
  if (clean.startsWith('Caveat:')) return true
  if (clean.startsWith('Note:')) return true
  // Empty after sanitization
  if (clean.length === 0) return true
  return false
}

export function generateTopic(input: TopicInput): string {
  const { toolCounts, errorCount } = input

  // Build candidate list from either userMessages array or legacy first/second fields
  const candidates = input.userMessages
    ?? [input.firstUserMessage, input.secondUserMessage].filter((m): m is string => m != null)

  // Find first real user intent message (skip commands, system injections, empty)
  const effectiveMessage = candidates.find(m => !isNonIntentMessage(m))

  if (!effectiveMessage) {
    return 'Empty session'
  }

  const parts: string[] = [truncateMessage(effectiveMessage)]

  const categoryCounts = computeCategoryCounts(toolCounts)
  const categories = topCategories(categoryCounts)

  const suffixes: string[] = [...categories]

  if (errorCount > ERROR_THRESHOLD) {
    suffixes.push(`${errorCount} errors`)
  }

  if (suffixes.length > 0) {
    parts.push(suffixes.join(', '))
  }

  return parts.join(SEPARATOR)
}
