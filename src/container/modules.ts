import 'reflect-metadata'
import { container } from 'tsyringe'
import { TOKENS } from './tokens'
import { DatabaseConnection } from '../infrastructure/database'
import { ClaudeCodeAdapter } from '../adapters/claude-code'
import { AdapterRegistry } from '../services/adapter-registry'
import { IndexManager } from '../services/index-manager'
import { SearchIndex } from '../services/search-index'
import { FreshnessGuard } from '../services/freshness-guard'
import { TokenBudgetManager } from '../services/token-budget-manager'
import { PaginationManager } from '../services/pagination-manager'

import { LocalLlmClient } from '../services/local-llm-client'
import { createLlmClient } from '../services/llm-client'
import { ProjectResolver } from '../services/project-resolver'
import { Analyzer } from '../services/analyzer'
import { ResponseFormatter } from '../services/response-formatter'
import { TurnIndexer } from '../services/turn-indexer'
import { PhaseClusterer } from '../services/phase-clusterer'
import { ContextAuditor } from '../services/context-auditor'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function registerInfrastructure(): void {
  const claudeDir = join(homedir(), '.claude')
  container.register(TOKENS.ClaudeDataDir, { useValue: claudeDir })
  container.register(TOKENS.LocalLlmUrl, { useValue: 'http://10.1.10.20:30000/v1' })
  container.register(TOKENS.LocalLlmModel, { useValue: 'QuantTrio/MiniMax-M2.5-AWQ' })

  // Database
  const dbConn = new DatabaseConnection(claudeDir)
  container.register(TOKENS.Database, { useValue: dbConn })

  // Adapter & Registry
  const adapter = new ClaudeCodeAdapter(claudeDir)
  const registry = new AdapterRegistry()
  registry.registerAdapter(adapter)
  container.register(TOKENS.AdapterRegistry, { useValue: registry })

  // Index & Search
  const db = dbConn.get()
  const indexManager = new IndexManager(db)
  container.register(TOKENS.IndexManager, { useValue: indexManager })

  const searchIndex = new SearchIndex(db)
  container.register(TOKENS.SearchIndex, { useValue: searchIndex })

  const turnIndexer = new TurnIndexer(db)
  container.register(TOKENS.TurnIndexer, { useValue: turnIndexer })

  // LLM — legacy local client + new fallback client (local-first, Anthropic as fallback)
  const localLlmUrl = 'http://10.1.10.20:30000/v1'
  const localLlmModel = 'QuantTrio/MiniMax-M2.5-AWQ'
  const llmClient = new LocalLlmClient(localLlmUrl, localLlmModel)
  container.register(TOKENS.LocalLlmClient, { useValue: llmClient })
  const fallbackLlmClient = createLlmClient(localLlmUrl, localLlmModel)
  container.register(TOKENS.LlmClient, { useValue: fallbackLlmClient })

  // Freshness Guard
  const freshnessGuard = new FreshnessGuard(registry, indexManager, claudeDir, db, llmClient, turnIndexer)
  container.register(TOKENS.FreshnessGuard, { useValue: freshnessGuard })

  // Services
  const tokenBudget = new TokenBudgetManager()
  container.register(TOKENS.TokenBudgetManager, { useValue: tokenBudget })

  const pagination = new PaginationManager()
  container.register(TOKENS.PaginationManager, { useValue: pagination })

  const projectResolver = new ProjectResolver(registry)
  container.register(TOKENS.ProjectResolver, { useValue: projectResolver })

  const analyzer = new Analyzer(db)
  container.register(TOKENS.Analyzer, { useValue: analyzer })

  const responseFormatter = new ResponseFormatter()
  container.register(TOKENS.ResponseFormatter, { useValue: responseFormatter })

  const phaseClusterer = new PhaseClusterer()
  container.register(TOKENS.PhaseClusterer, { useValue: phaseClusterer })

  const contextAuditor = new ContextAuditor(db)
  contextAuditor.ensureIndexes()
  container.register(TOKENS.ContextAuditor, { useValue: contextAuditor })
}

export function registerAll(): void {
  registerInfrastructure()
}
