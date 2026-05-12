import { join } from 'node:path'
import type { MemoryEntry } from '../../types'
import { fileExists, readTextFile, listFiles, listDirectories } from '../../infrastructure/file-system'

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/
const FIELD_RE = /^(\w+):\s*(.+)$/

interface FrontmatterFields {
  readonly name: string
  readonly description: string
  readonly type: string
}

function parseFrontmatter(content: string): { fields: FrontmatterFields; body: string } | undefined {
  const match = FRONTMATTER_RE.exec(content)
  if (!match) return undefined

  const rawFields = match[1] ?? ''
  const body = (match[2] ?? '').trim()
  const fields: Record<string, string> = {}

  for (const line of rawFields.split('\n')) {
    const fieldMatch = FIELD_RE.exec(line.trim())
    if (fieldMatch?.[1] && fieldMatch[2]) {
      fields[fieldMatch[1]] = fieldMatch[2].trim()
    }
  }

  if (!fields['name'] || !fields['description'] || !fields['type']) return undefined

  return {
    fields: fields as unknown as FrontmatterFields,
    body,
  }
}

export class MemoryReader {
  constructor(private readonly claudeDir: string) {}

  async *readMemory(projectSlug?: string): AsyncIterable<MemoryEntry> {
    if (projectSlug) {
      yield* this.readProjectMemory(projectSlug)
    } else {
      yield* this.readAllProjectMemory()
    }
  }

  private async *readAllProjectMemory(): AsyncIterable<MemoryEntry> {
    const projectsDir = join(this.claudeDir, 'projects')
    if (!(await fileExists(projectsDir))) return

    const slugs = await listDirectories(projectsDir)
    for (const slug of slugs) {
      yield* this.readProjectMemory(slug)
    }
  }

  private async *readProjectMemory(projectSlug: string): AsyncIterable<MemoryEntry> {
    const memoryDir = join(this.claudeDir, 'projects', projectSlug, 'memory')
    if (!(await fileExists(memoryDir))) return

    const files = await listFiles(memoryDir, '.md')
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

      const validTypes = new Set(['user', 'feedback', 'project', 'reference'])
      const entryType = validTypes.has(parsed.fields.type)
        ? (parsed.fields.type as MemoryEntry['type'])
        : 'project'

      yield {
        projectSlug,
        fileName,
        name: parsed.fields.name,
        description: parsed.fields.description,
        type: entryType,
        content: parsed.body,
      }
    }
  }
}
