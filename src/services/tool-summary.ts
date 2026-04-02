import { basename } from 'node:path'

export function extractToolParams(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return name
  const params = input as Record<string, unknown>
  if ('file_path' in params) return `${name}: ${basename(String(params.file_path))}`
  if ('path' in params) return `${name}: ${params.path}`
  if ('pattern' in params) return `${name}: ${params.pattern}`
  if ('command' in params) return `${name}: ${String(params.command).slice(0, 60)}`
  const keys = ['ref', 'value', 'footprint', 'component', 'netName', 'label']
  const extracted = keys.filter(k => k in params).map(k => `${k}=${params[k]}`).join(', ')
  return extracted ? `${name}: ${extracted}` : name
}
