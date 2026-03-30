export class ToolResultResolver {
  constructor(private readonly claudeDir: string) {}

  async resolveToolResult(
    _sessionId: string,
    _projectSlug: string,
    _toolResultContent: unknown,
  ): Promise<string | undefined> {
    // TODO: Implement persisted output resolution
    // Handle 5 naming patterns: b*.txt, toolu_*.txt, mcp-*.txt, webfetch-*.pdf, pdf-*/
    return undefined
  }
}
