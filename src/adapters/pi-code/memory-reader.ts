import { join } from 'node:path'
import type { MemoryEntry } from '../../types'
import { fileExists, readTextFile, listFiles } from '../../infrastructure/file-system'

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/
const FIELD_RE = /^(\w+):\s*(.+)$/

/**
 * Pi memory is global (~/.pi/agent/memory/), not per-project. Surfaced under the
 * synthetic project slug `pi-global` so it shows up in cross-project memory queries.
 */
export const PI_MEMORY_SLUG = 'pi-global'

interface Frontmatter {
  readonly name: string
  readonly description: string
  readonly type: string
}

function parseFrontmatter(content: string): { fields: Frontmatter; body: string } | undefined {
  const match = FRONTMATTER_RE.exec(content)
  if (!match) return undefined
  const fields: Record<string, string> = {}
  for (const line of (match[1] ?? '').split('\n')) {
    const fieldMatch = FIELD_RE.exec(line.trim())
    if (fieldMatch && fieldMatch[1] && fieldMatch[2]) fields[fieldMatch[1]] = fieldMatch[2].trim()
  }
  if (!fields['name'] || !fields['description'] || !fields['type']) return undefined
  return { fields: fields as unknown as Frontmatter, body: (match[2] ?? '').trim() }
}

export class PiMemoryReader {
  constructor(private readonly piDir: string) {}

  async *readMemory(projectSlug?: string): AsyncIterable<MemoryEntry> {
    // Only emit pi memory when the caller asks for the synthetic slug or for all projects.
    if (projectSlug && projectSlug !== PI_MEMORY_SLUG) return

    const memoryDir = join(this.piDir, 'memory')
    if (!(await fileExists(memoryDir))) return

    const files = await listFiles(memoryDir, '.md')
    const validTypes = new Set(['user', 'feedback', 'project', 'reference'])

    for (const fileName of files) {
      if (fileName === 'MEMORY.md') continue
      const filePath = join(memoryDir, fileName)
      let content: string
      try {
        content = await readTextFile(filePath)
      } catch {
        continue
      }
      const parsed = parseFrontmatter(content)
      if (!parsed) continue

      const entryType = validTypes.has(parsed.fields.type)
        ? (parsed.fields.type as MemoryEntry['type'])
        : 'project'

      yield {
        projectSlug: PI_MEMORY_SLUG,
        fileName,
        name: parsed.fields.name,
        description: parsed.fields.description,
        type: entryType,
        content: parsed.body,
      }
    }
  }
}
