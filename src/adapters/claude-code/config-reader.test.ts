import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { ConfigReader } from './config-reader'

const CLAUDE_HOME = join(__dirname, '../../../fixtures/claude-home')

describe('ConfigReader', () => {
  const reader = new ConfigReader(CLAUDE_HOME)

  describe('readSettings', () => {
    it('reads settings.json from fixture', async () => {
      const settings = await reader.readSettings()
      expect(settings).toBeDefined()
      expect(settings!.model).toBe('claude-opus-4-6')
    })
  })

  describe('readLocalSettings', () => {
    it('reads settings.local.json from fixture', async () => {
      const local = await reader.readLocalSettings()
      expect(local).toBeDefined()
      expect(local!.permissions).toBeDefined()
    })
  })

  describe('readGlobalClaudeMd', () => {
    it('reads CLAUDE.md from fixture claude home', async () => {
      const content = await reader.readGlobalClaudeMd()
      expect(content).toBeDefined()
      expect(content).toContain('Global Claude Instructions')
      expect(content).toContain('TypeScript strict mode')
    })
  })

  describe('readProjectClaudeMd', () => {
    it('reads CLAUDE.md from a given project path', async () => {
      // The fixture CLAUDE.md is in the claude-home dir itself
      const content = await reader.readProjectClaudeMd(CLAUDE_HOME)
      expect(content).toBeDefined()
      expect(content).toContain('Global Claude Instructions')
    })

    it('returns undefined for non-existent project CLAUDE.md', async () => {
      const content = await reader.readProjectClaudeMd('/tmp/nonexistent-project-path')
      expect(content).toBeUndefined()
    })
  })

  describe('readStatsCache', () => {
    it('returns undefined when stats-cache.json does not exist', async () => {
      const stats = await reader.readStatsCache()
      expect(stats).toBeUndefined()
    })
  })

  describe('missing files', () => {
    it('returns undefined for all methods when claudeDir does not exist', async () => {
      const badReader = new ConfigReader('/tmp/nonexistent-claude-dir')
      expect(await badReader.readGlobalClaudeMd()).toBeUndefined()
      expect(await badReader.readSettings()).toBeUndefined()
      expect(await badReader.readLocalSettings()).toBeUndefined()
      expect(await badReader.readStatsCache()).toBeUndefined()
    })
  })
})
