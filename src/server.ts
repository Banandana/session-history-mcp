import 'reflect-metadata'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { registerAll } from './container'
import { registerTools } from './tools'

async function main() {
  registerAll()

  const server = new McpServer({
    name: 'claude-session-mcp',
    version: '0.1.0',
  })

  registerTools(server)

  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('claude-session-mcp server running on stdio')
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
