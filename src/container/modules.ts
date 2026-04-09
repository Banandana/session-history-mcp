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
import { createLlmClient, OpenAiLlmClient } from '../services/llm-client'
import { ProjectResolver } from '../services/project-resolver'
import { Analyzer } from '../services/analyzer'
import { ResponseFormatter } from '../services/response-formatter'
import { TurnIndexer } from '../services/turn-indexer'
import { PhaseClusterer } from '../services/phase-clusterer'
import { ContextAuditor } from '../services/context-auditor'
import { EmbeddingIndexer } from '../services/embedding-indexer'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Local LLM defaults. Override via LOCAL_LLM_URL / LOCAL_LLM_MODEL env vars
// so the same repo works on any host without code changes.
const DEFAULT_LOCAL_LLM_URL = 'http://localhost:30000/v1'
const DEFAULT_LOCAL_LLM_MODEL = 'QuantTrio/MiniMax-M2.5-AWQ'

export function registerInfrastructure(): void {
  const claudeDir = join(homedir(), '.claude')
  const localLlmUrl = process.env.LOCAL_LLM_URL ?? DEFAULT_LOCAL_LLM_URL
  const localLlmModel = process.env.LOCAL_LLM_MODEL ?? DEFAULT_LOCAL_LLM_MODEL

  container.register(TOKENS.ClaudeDataDir, { useValue: claudeDir })
  container.register(TOKENS.LocalLlmUrl, { useValue: localLlmUrl })
  container.register(TOKENS.LocalLlmModel, { useValue: localLlmModel })

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
  // Ensure schema/migrations run before any service that relies on post-v0
  // columns (e.g. ContextAuditor.ensureIndexes references cost_usd from v3).
  indexManager.ensureSchema()
  container.register(TOKENS.IndexManager, { useValue: indexManager })

  const searchIndex = new SearchIndex(db)
  container.register(TOKENS.SearchIndex, { useValue: searchIndex })

  const turnIndexer = new TurnIndexer(db)
  container.register(TOKENS.TurnIndexer, { useValue: turnIndexer })

  // LLM — legacy local client + new fallback client (local-first, Anthropic as fallback)
  const llmClient = new LocalLlmClient(localLlmUrl, localLlmModel)
  container.register(TOKENS.LocalLlmClient, { useValue: llmClient })
  const fallbackLlmClient = createLlmClient(localLlmUrl, localLlmModel)
  container.register(TOKENS.LlmClient, { useValue: fallbackLlmClient })

  // Freshness Guard — embedding indexer is wired below after construction
  // so the guard can fire-and-forget embedding runs alongside summarization.
  let freshnessGuard: FreshnessGuard

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

  // Embedding indexer — opt-in via VLLM_EMBEDDING_MODEL env var. When the
  // env var is unset, the token is registered as `null` and semantic_search
  // returns an informative error telling the user how to enable it.
  const embeddingModel = process.env.VLLM_EMBEDDING_MODEL
  let embeddingIndexer: EmbeddingIndexer | null = null
  if (embeddingModel) {
    const embeddingDim = Number(process.env.VLLM_EMBEDDING_DIM ?? '1024')
    const embeddingBaseUrl = process.env.VLLM_EMBEDDING_URL ?? localLlmUrl
    const embeddingClient = new OpenAiLlmClient(localLlmUrl, localLlmModel, {
      embeddingModel,
      embeddingDim,
      embeddingBaseUrl,
    })
    embeddingIndexer = new EmbeddingIndexer(db, embeddingClient, embeddingDim)
  }
  container.register(TOKENS.EmbeddingIndexer, { useValue: embeddingIndexer })

  // Now build the FreshnessGuard with the embedding indexer attached so
  // post-sync embedding runs fire-and-forget alongside summarization.
  freshnessGuard = new FreshnessGuard(
    registry,
    indexManager,
    claudeDir,
    db,
    llmClient,
    turnIndexer,
    embeddingIndexer,
  )
  container.register(TOKENS.FreshnessGuard, { useValue: freshnessGuard })
}

export function registerAll(): void {
  registerInfrastructure()
}
