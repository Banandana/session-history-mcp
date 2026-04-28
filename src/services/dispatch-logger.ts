import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ToolInvocationLogger } from './invocation-logger'

/**
 * Wraps `server.tool(...)` so every registered handler is intercepted by the
 * ToolInvocationLogger. The wrapper:
 *   - times the handler
 *   - records status='ok' on return, 'error' on throw
 *   - measures result_size as the JSON byte length of the response
 *   - never lets logging failures break the actual call
 *
 * Call ONCE at server bootstrap, BEFORE registerTools(server).
 */
export function instrumentDispatch(
  server: McpServer,
  logger: ToolInvocationLogger,
): void {
  // McpServer.tool has overloaded signatures. We don't care about the exact
  // shape — we know the handler is the LAST argument and that registration
  // returns a value we should pass through.
  const orig = server.tool.bind(server) as (...args: unknown[]) => unknown
  ;(server as unknown as { tool: (...args: unknown[]) => unknown }).tool =
    function instrumentedTool(...args: unknown[]): unknown {
      if (args.length === 0) return orig(...args)
      const toolName = String(args[0])
      const handlerIdx = args.length - 1
      const handler = args[handlerIdx]
      if (typeof handler !== 'function') return orig(...args)

      const wrapped = async (params: unknown, extra: unknown): Promise<unknown> => {
        const start = Date.now()
        let status: 'ok' | 'error' = 'ok'
        let result: unknown
        try {
          result = await (handler as (...a: unknown[]) => unknown)(params, extra)
          return result
        } catch (err) {
          status = 'error'
          throw err
        } finally {
          const durationMs = Date.now() - start
          let resultSize = 0
          if (status === 'ok' && result) {
            try {
              resultSize = JSON.stringify(result).length
            } catch {
              resultSize = 0
            }
          }
          logger.record({
            toolName,
            rawParams: params,
            status,
            durationMs,
            resultSize,
          })
        }
      }

      const newArgs = [...args]
      newArgs[handlerIdx] = wrapped
      return orig(...newArgs)
    }
}
