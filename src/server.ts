import 'reflect-metadata'
import { container } from 'tsyringe'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { registerAll } from './container'
import { TOKENS } from './container/tokens'
import { registerTools } from './tools'
import { instrumentDispatch } from './services/dispatch-logger'
import type { ToolInvocationLogger } from './services/invocation-logger'

async function main() {
  registerAll()

  const server = new McpServer({
    name: 'claude-session-mcp',
    version: '0.1.0',
  })

  // Wrap server.tool() so every MCP call is logged. Must happen BEFORE
  // registerTools so the wrapper sees every registration.
  const logger = container.resolve<ToolInvocationLogger>(TOKENS.ToolInvocationLogger)
  instrumentDispatch(server, logger)

  registerTools(server)

  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('claude-session-mcp server running on stdio')
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
