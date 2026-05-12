import pino, { type Logger as PinoLogger } from 'pino'

/**
 * MCP servers communicate over stdio — stdout is reserved for JSON-RPC traffic.
 * All logs must go to stderr or the client disconnects. Pino's default destination
 * is stdout, so we override to fd 2.
 *
 * Level: `LOG_LEVEL` env var (default `info`). Set `LOG_LEVEL=debug` to enable
 * verbose traces; `silent` disables logging entirely.
 */

const level = process.env.LOG_LEVEL ?? 'info'
const isDev = process.env.NODE_ENV !== 'production'

export const logger: PinoLogger = pino(
  {
    level,
    ...(isDev
      ? {
          transport: {
            target: 'pino-pretty',
            options: {
              destination: 2,
              colorize: true,
              translateTime: 'SYS:HH:MM:ss.l',
              ignore: 'pid,hostname',
            },
          },
        }
      : {}),
  },
  isDev ? undefined : pino.destination(2),
)

export type Logger = PinoLogger

export function childLogger(name: string, fields: Record<string, unknown> = {}): PinoLogger {
  return logger.child({ component: name, ...fields })
}
