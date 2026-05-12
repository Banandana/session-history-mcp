import 'reflect-metadata'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { registerAll, container } from './container'
import { TOKENS } from './container/tokens'
import { registerTools } from './tools'
import { instrumentDispatch } from './services/dispatch-logger'
import type { ToolInvocationLogger } from './services/invocation-logger'
import { logger } from './infrastructure/logger'

async function main(): Promise<void> {
  registerAll()

  const server = new McpServer({
    name: 'claude-session-mcp',
    version: '0.1.0',
  })

  // Wrap server.tool() so every MCP call is logged. Must happen BEFORE
  // registerTools so the wrapper sees every registration.
  const invocationLogger = container.get<ToolInvocationLogger>(TOKENS.ToolInvocationLogger)
  instrumentDispatch(server, invocationLogger)

  registerTools(server)

  const transport = new StdioServerTransport()
  await server.connect(transport)
  logger.info('claude-session-mcp server running on stdio')
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'fatal: server failed to start')
  process.exit(1)
})
