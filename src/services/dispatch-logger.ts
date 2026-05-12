import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ToolInvocationLogger } from './invocation-logger'

/**
 * Wraps `server.tool(...)` (legacy) and `server.registerTool(...)` (modern)
 * so every registered handler is intercepted by the ToolInvocationLogger.
 * The wrapper:
 *   - times the handler
 *   - records status='ok' on return, 'error' on throw
 *   - measures result_size as the JSON byte length of the response
 *   - warns to stderr when an 'ok' handler returns a falsy value (likely bug)
 *   - never lets logging failures break the actual call
 *
 * Call ONCE at server bootstrap, BEFORE registerTools(server).
 */
export function instrumentDispatch(
  server: McpServer,
  logger: ToolInvocationLogger,
): void {
  function wrapHandler(toolName: string, handler: (...a: unknown[]) => unknown) {
    return async (params: unknown, extra: unknown): Promise<unknown> => {
      const start = Date.now()
      let status: 'ok' | 'error' = 'ok'
      let result: unknown
      try {
        result = await handler(params, extra)
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
        } else if (status === 'ok' && !result) {
          // Don't lie about success — but surface this since a falsy handler
          // return value almost always indicates a broken handler.
          console.warn(
            `[dispatch-logger] tool=${toolName} returned falsy result with ok status`,
          )
        }
        try {
          logger.record({
            toolName,
            rawParams: params,
            status,
            durationMs,
            resultSize,
          })
        } catch {
          // logger failure must never break the call
        }
      }
    }
  }

  // ── Patch legacy server.tool(...) ──
  // McpServer.tool has overloaded signatures. We don't care about the exact
  // shape — we know the handler is the LAST argument and that registration
  // returns a value we should pass through.
  const origTool = server.tool.bind(server) as (...args: unknown[]) => unknown
  ;(server as unknown as { tool: (...args: unknown[]) => unknown }).tool =
    function instrumentedTool(...args: unknown[]): unknown {
      if (args.length === 0) return origTool(...args)
      const toolName = String(args[0])
      const handlerIdx = args.length - 1
      const handler = args[handlerIdx]
      if (typeof handler !== 'function') return origTool(...args)

      const wrapped = wrapHandler(toolName, handler as (...a: unknown[]) => unknown)
      const newArgs = [...args]
      newArgs[handlerIdx] = wrapped
      return origTool(...newArgs)
    }

  // ── Patch modern server.registerTool(name, config, handler) ──
  // Signature: registerTool(name, { title?, description?, inputSchema?, ... }, cb)
  // The handler is always the last positional argument; patch defensively in
  // case the SDK adds further overloads.
  const serverAsAny = server as unknown as {
    registerTool?: (...args: unknown[]) => unknown
  }
  if (typeof serverAsAny.registerTool === 'function') {
    const origRegister = serverAsAny.registerTool.bind(server) as (...args: unknown[]) => unknown
    serverAsAny.registerTool = function instrumentedRegisterTool(...args: unknown[]): unknown {
      if (args.length === 0) return origRegister(...args)
      const toolName = String(args[0])
      const handlerIdx = args.length - 1
      const handler = args[handlerIdx]
      if (typeof handler !== 'function') return origRegister(...args)

      const wrapped = wrapHandler(toolName, handler as (...a: unknown[]) => unknown)
      const newArgs = [...args]
      newArgs[handlerIdx] = wrapped
      return origRegister(...newArgs)
    }
  }
}
