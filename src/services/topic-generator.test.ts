import { describe, it, expect } from 'vitest'
import { generateTopic } from './topic-generator'

describe('generateTopic', () => {
  describe('empty session', () => {
    it('returns "Empty session" when firstUserMessage is undefined', () => {
      expect(generateTopic({ firstUserMessage: undefined, toolCounts: {}, errorCount: 0 })).toBe('Empty session')
    })

    it('returns "Empty session" when firstUserMessage is empty string', () => {
      expect(generateTopic({ firstUserMessage: '', toolCounts: {}, errorCount: 0 })).toBe('Empty session')
    })
  })

  describe('message truncation', () => {
    it('returns message as-is when under 60 chars', () => {
      const msg = 'Short message'
      const result = generateTopic({ firstUserMessage: msg, toolCounts: {}, errorCount: 0 })
      expect(result).toBe('Short message')
    })

    it('truncates message at 60 chars and appends ellipsis', () => {
      const msg = 'A'.repeat(80)
      const result = generateTopic({ firstUserMessage: msg, toolCounts: {}, errorCount: 0 })
      expect(result.startsWith('A'.repeat(60))).toBe(true)
      expect(result).toContain('...')
      expect(result.split(' — ')[0]).toBe('A'.repeat(60) + '...')
    })

    it('does not truncate exactly 60 char message', () => {
      const msg = 'A'.repeat(60)
      const result = generateTopic({ firstUserMessage: msg, toolCounts: {}, errorCount: 0 })
      expect(result.split(' — ')[0]).toBe(msg)
      expect(result).not.toContain('...')
    })
  })

  describe('tool category classification', () => {
    it('detects schematic work from kicad tools', () => {
      const result = generateTopic({
        firstUserMessage: 'Run full schematic audit',
        toolCounts: { 'mcp__kicad__add_wire': 10, 'mcp__kicad__place_component': 5 },
        errorCount: 0,
      })
      expect(result).toContain('schematic work')
    })

    it('detects component search from pcbparts tools', () => {
      const result = generateTopic({
        firstUserMessage: 'Find a capacitor',
        toolCounts: { 'mcp__pcbparts__jlc_search': 8 },
        errorCount: 0,
      })
      expect(result).toContain('component search')
    })

    it('detects component search from mouser tools', () => {
      const result = generateTopic({
        firstUserMessage: 'Search mouser',
        toolCounts: { 'mcp__mouser__search_by_keyword': 6 },
        errorCount: 0,
      })
      expect(result).toContain('component search')
    })

    it('detects component search from jlcpcb tools', () => {
      const result = generateTopic({
        firstUserMessage: 'Check jlcpcb stock',
        toolCounts: { 'mcp__jlcpcb-search__search_components': 4 },
        errorCount: 0,
      })
      expect(result).toContain('component search')
    })

    it('detects circuit simulation from spicebridge tools', () => {
      const result = generateTopic({
        firstUserMessage: 'Simulate filter',
        toolCounts: { 'mcp__spicebridge__run_ac_analysis': 3 },
        errorCount: 0,
      })
      expect(result).toContain('circuit simulation')
    })

    it('detects code exploration from Grep/Read/Glob', () => {
      const result = generateTopic({
        firstUserMessage: 'Read the source files',
        toolCounts: { 'Grep': 15, 'Read': 12, 'Glob': 3 },
        errorCount: 0,
      })
      expect(result).toContain('code exploration')
    })

    it('detects code changes from Edit/Write', () => {
      const result = generateTopic({
        firstUserMessage: 'Add unit tests for auth',
        toolCounts: { 'Edit': 8, 'Write': 2 },
        errorCount: 0,
      })
      expect(result).toContain('code changes')
    })

    it('detects shell operations from Bash', () => {
      const result = generateTopic({
        firstUserMessage: 'Run the build',
        toolCounts: { 'Bash': 7 },
        errorCount: 0,
      })
      expect(result).toContain('shell operations')
    })

    it('detects research from WebFetch/WebSearch', () => {
      const result = generateTopic({
        firstUserMessage: 'Research best practices',
        toolCounts: { 'WebFetch': 5, 'WebSearch': 2 },
        errorCount: 0,
      })
      expect(result).toContain('research')
    })

    it('detects agent delegation from Agent/Task tools', () => {
      const result = generateTopic({
        firstUserMessage: 'Delegate parallel tasks',
        toolCounts: { 'Agent': 4, 'Task': 3 },
        errorCount: 0,
      })
      expect(result).toContain('agent delegation')
    })
  })

  describe('top 2 category selection', () => {
    it('includes only top 2 categories by count', () => {
      const result = generateTopic({
        firstUserMessage: 'Full schematic audit',
        toolCounts: {
          'mcp__kicad__add_wire': 20,
          'Edit': 10,
          'Bash': 5,
        },
        errorCount: 0,
      })
      expect(result).toContain('schematic work')
      expect(result).toContain('code changes')
      expect(result).not.toContain('shell operations')
    })

    it('includes only message when no tools used', () => {
      const result = generateTopic({
        firstUserMessage: 'Simple question',
        toolCounts: {},
        errorCount: 0,
      })
      expect(result).toBe('Simple question')
    })

    it('includes one category when only one present', () => {
      const result = generateTopic({
        firstUserMessage: 'Only bash stuff',
        toolCounts: { 'Bash': 3 },
        errorCount: 0,
      })
      expect(result).toContain('shell operations')
    })
  })

  describe('error indicator', () => {
    it('does not append error indicator when errorCount <= 5', () => {
      const result = generateTopic({
        firstUserMessage: 'Some task',
        toolCounts: {},
        errorCount: 5,
      })
      expect(result).not.toContain('errors')
    })

    it('appends error indicator when errorCount > 5', () => {
      const result = generateTopic({
        firstUserMessage: 'Add unit tests for auth',
        toolCounts: { 'Edit': 5 },
        errorCount: 8,
      })
      expect(result).toContain('8 errors')
    })

    it('error indicator shows correct count', () => {
      const result = generateTopic({
        firstUserMessage: 'Fix all the things',
        toolCounts: {},
        errorCount: 42,
      })
      expect(result).toContain('42 errors')
    })
  })

  describe('output format', () => {
    it('joins parts with " — "', () => {
      const result = generateTopic({
        firstUserMessage: 'Full schematic audit',
        toolCounts: { 'mcp__kicad__add_wire': 10, 'Edit': 5 },
        errorCount: 0,
      })
      expect(result).toBe('Full schematic audit — schematic work, code changes')
    })

    it('produces correct format with error indicator', () => {
      const result = generateTopic({
        firstUserMessage: 'Add unit tests for auth',
        toolCounts: { 'Edit': 5 },
        errorCount: 8,
      })
      expect(result).toBe('Add unit tests for auth — code changes, 8 errors')
    })

    it('produces correct format with tool categories and errors', () => {
      const result = generateTopic({
        firstUserMessage: 'Full schematic audit',
        toolCounts: { 'mcp__kicad__add_wire': 10, 'Edit': 5 },
        errorCount: 8,
      })
      expect(result).toBe('Full schematic audit — schematic work, code changes, 8 errors')
    })
  })

  describe('category aggregation by total count', () => {
    it('aggregates counts across multiple tools in the same category', () => {
      const result = generateTopic({
        firstUserMessage: 'Heavy kicad work',
        toolCounts: {
          'Grep': 20,
          'Read': 15,
          'mcp__kicad__add_wire': 10,
          'mcp__kicad__place_component': 8,
        },
        errorCount: 0,
      })
      // code exploration: 35, schematic work: 18
      expect(result).toContain('code exploration')
      expect(result).toContain('schematic work')
    })
  })
})
