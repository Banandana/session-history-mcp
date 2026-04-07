import { stat, readFile, readdir } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

export async function fileSize(path: string): Promise<number> {
  const s = await stat(path)
  return s.size
}

export async function fileMtime(path: string): Promise<number> {
  const s = await stat(path)
  return s.mtimeMs
}

export async function readJsonFile<T>(path: string): Promise<T> {
  const content = await readFile(path, 'utf-8')
  return JSON.parse(content) as T
}

export async function readTextFile(path: string): Promise<string> {
  return readFile(path, 'utf-8')
}

export async function listDirectories(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true })
  return entries.filter(e => e.isDirectory()).map(e => e.name)
}

export async function listFiles(path: string, extension?: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true })
  return entries
    .filter(e => e.isFile() && (!extension || e.name.endsWith(extension)))
    .map(e => e.name)
}

export async function* streamJsonlLines(
  path: string,
  startOffset: number = 0
): AsyncIterable<{ line: string; offset: number }> {
  // Detect line ending style by reading the first chunk of the file.
  // readline with crlfDelay: Infinity strips both \r\n and \n, so we
  // can't tell from line content alone. Read a small buffer to check.
  const detectBuf = Buffer.alloc(4096)
  const fh = await import('node:fs/promises').then(m => m.open(path, 'r'))
  try {
    await fh.read(detectBuf, 0, 4096, 0)
  } finally {
    await fh.close()
  }
  const hasCrlf = detectBuf.includes(0x0d) // \r byte present → CRLF
  const lineEndingSize = hasCrlf ? 2 : 1

  const stream = createReadStream(path, {
    start: startOffset,
    encoding: 'utf-8',
  })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  let offset = startOffset
  for await (const line of rl) {
    if (line.trim()) {
      yield { line, offset }
    }
    offset += Buffer.byteLength(line, 'utf-8') + lineEndingSize
  }
}
