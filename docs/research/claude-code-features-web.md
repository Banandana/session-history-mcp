# Claude Code Architecture & Features Research

Research compiled 2026-03-30 for the claude-session-mcp project.

---

## 1. Local Storage Architecture

### Directory Structure

Claude Code stores all persistent data under `~/.claude/`. The structure is:

```
~/.claude/
  CLAUDE.md                    # User-level memory, loaded every session
  settings.json                # Global settings (permissions, model, hooks)
  history.jsonl                # Chronological log of all user prompts
  stats-cache.json             # Aggregated usage metrics
  projects/                    # Session transcripts per project
    <encoded-project-path>/
      <sessionId>.jsonl        # Individual session transcript
      agent-<shortId>.jsonl    # Subagent session transcripts
      sessions-index.json      # Index with summaries, message counts, branches
      memory/                  # Auto-memory per project
        MEMORY.md              # Memory index entrypoint
        <topic>.md             # Individual topic memory files
  file-history/                # File checkpoints for undo/rollback
    <sessionId>/
      <contentHash>@v<N>       # Versioned file backups
  todos/                       # Task lists per session
  plans/                       # Plan mode markdown documents
  commands/                    # Custom slash commands
  skills/                      # Complex skills with scripts
  plugins/                     # Plugin marketplace installations
  debug/                       # Session debug logs
  session-env/                 # Per-session environment variables
  shell-snapshots/             # Shell environment state captures
  telemetry/                   # Usage telemetry (if enabled)
```

The `<encoded-project-path>` is the project's absolute path with every non-alphanumeric character replaced by `-`. For example, `/home/user/my-project` becomes `-home-user-my-project`.

Additionally, `~/.claude.json` (at root, not inside `~/.claude/`) is a system-managed file containing OAuth state, user preferences, MCP server configs, per-project settings, feature flags, and usage tracking. It is not intended for manual editing.

**Sources:**
- [Anatomy of the .claude/ Folder](https://blog.dailydoseofds.com/p/anatomy-of-the-claude-folder)
- [Extracted logic of ~/.claude directory](https://gist.github.com/samkeen/dc6a9771a78d1ecee7eb9ec1307f1b52)
- [How Claude Code Manages Local Storage](https://milvus.io/blog/why-claude-code-feels-so-stable-a-developers-deep-dive-into-its-local-storage-design.md)
- [The Complete .claude Directory Guide](https://computingforgeeks.com/claude-code-dot-claude-directory-guide/)

---

## 2. Session JSONL Format

### Overview

Sessions are stored as JSONL (JSON Lines) files -- append-only event streams where each line is a self-contained JSON object. This design provides crash resistance (only the last partial line can be lost) and efficient writes (no rewriting of existing data).

### Event Types

| Event Type | Purpose |
|---|---|
| `session_start` | Marks session beginning with ID, parent ID, timestamp, project path |
| `message` | User or assistant messages with content blocks |
| `tool_use` | Tool invocations with name and input parameters |
| `tool_result` | Tool execution outcomes with duration metrics |
| `compaction` | Context reduction summaries and token savings |
| `session_end` | Duration, token count, and cost statistics |
| `file-history-snapshot` | Tracks file modifications with version references |

### Message Schemas

**Session Start:**
```json
{
  "sessionId": "b2c3d4e5-f6a7-8901-bcde-f12345678901",
  "parentSessionId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "type": "session_start",
  "resumedFrom": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
}
```

**User Message:**
```json
{
  "type": "user",
  "uuid": "<unique-message-id>",
  "parentUuid": null,
  "message": {
    "role": "user",
    "content": "Hello"
  },
  "sessionId": "...",
  "cwd": "/path/to/project",
  "gitBranch": "main",
  "timestamp": "2026-03-20T10:00:01Z"
}
```

**Assistant Message:**
```json
{
  "type": "assistant",
  "uuid": "<unique-message-id>",
  "parentUuid": "<parent-message-uuid>",
  "message": {
    "role": "assistant",
    "content": [
      {"type": "text", "text": "..."},
      {"type": "thinking", "thinking": "..."},
      {"type": "tool_use", "id": "tu_abc123", "name": "Read", "input": {...}}
    ]
  },
  "toolUseMessages": [...]
}
```

**Tool Use:**
```json
{
  "type": "tool_use",
  "toolName": "Read|Edit|Bash|Grep|...",
  "toolInput": {...},
  "toolUseId": "tu_abc123",
  "sessionId": "..."
}
```

**Tool Result:**
```json
{
  "type": "tool_result",
  "toolUseId": "tu_abc123",
  "content": "...",
  "durationMs": 3400
}
```

**File History Snapshot:**
```json
{
  "type": "file-history-snapshot",
  "trackedFileBackups": {
    "src/main.ts": "<contentHash>@v1",
    "README.md": null
  }
}
```

### Session Chains

Sessions form parent-child trees. When you resume a session or spawn a subagent, a `parentSessionId` / `resumedFrom` link is created. Sub-agents spawned by the Task tool get their own transcript files (`agent-<shortId>.jsonl`) but inherit the parent session ID.

### UUID Correlation

The same session UUID links data across directories: session transcripts, file-history subdirectories, todos filenames, and debug logs.

**Sources:**
- [Session Storage - ClaudeWorld](https://claude-world.com/tutorials/s16-session-storage/)
- [claude-code-transcripts (simonw)](https://github.com/simonw/claude-code-transcripts)
- [claude-JSONL-browser](https://github.com/withLinda/claude-JSONL-browser)
- [Extracted logic of ~/.claude directory](https://gist.github.com/samkeen/dc6a9771a78d1ecee7eb9ec1307f1b52)

---

## 3. Session Management CLI

### Resume and Continue

| Command | Description |
|---|---|
| `claude --continue` / `claude -c` | Resume most recent session in current directory |
| `claude --resume` / `claude -r` | Interactive picker for all recent sessions |
| `claude --resume <session-id>` | Resume specific session by ID |
| `/resume` | Switch sessions from within an active session |
| `/rename <name>` | Assign human-readable name to current session |

### Interactive Picker Controls

- **A** -- Toggle between current directory and all projects
- **B** -- Filter by current git branch

Session picker displays: summaries, message counts, git branch names, timestamps.

### Session Data Commands

| Command | Description |
|---|---|
| `/export [filename]` | Save conversation to file or clipboard |
| `/clear` | Reset session context (preserves disk storage) |
| `/compact [focus]` | Summarize conversation to save tokens |
| `/context` | Visualize current context usage as colored grid |
| `/cost` | Show token usage and cost statistics |
| `/stats` | Display daily usage, session history, streaks |
| `/history` | Display global conversation history |
| `Ctrl+R` | Reverse-search through previous inputs |
| `Esc Esc` | Rewind menu to jump to previous points / fork |

### Headless / Programmatic Mode

Add `-p` (or `--print`) for non-interactive operation:

```bash
claude -p "Summarize this project" --output-format json
```

Output formats: `text` (default), `json` (structured with session ID and metadata), `stream-json` (newline-delimited for real-time streaming).

Session continuation in headless mode:
```bash
session_id=$(claude -p "Start a review" --output-format json | jq -r '.session_id')
claude -p "Continue that review" --resume "$session_id"
```

The `--bare` flag skips auto-discovery (hooks, skills, plugins, MCP servers, CLAUDE.md) for CI/script reproducibility.

**Sources:**
- [How to resume, search, and manage conversations](https://kentgigger.com/posts/claude-code-conversation-history)
- [Run Claude Code programmatically](https://code.claude.com/docs/en/headless)
- [Claude Code --continue and --resume guide](https://pasqualepillitteri.it/en/news/366/claude-code-continue-resume-guide)
- [Claude Code Session Management - Steve Kinney](https://stevekinney.com/courses/ai-development/claude-code-session-management)

---

## 4. Context Window Management

### Context Window Size

Claude Code operates with a **200k token context window**.

### Compaction

The `/compact` command compresses conversation history into a condensed summary. Auto-compaction triggers at approximately **75% utilization** (around 150k tokens), reserving 25-35% capacity for reasoning quality.

The system reserves approximately 15-20k tokens for the compaction process itself. Compaction events are recorded in the JSONL transcript.

### Sidechains (Subagent Context Isolation)

When Claude Code spawns subagents (via the Task tool or `@agent` syntax), they run in parallel "sidechains" with their own context windows. Only main chain entries count toward the primary context -- sidechain tool calls and intermediate results stay isolated. The parent receives only the final summary.

### Context Editing

The Escape-Escape rewind menu allows forking a conversation at any point, creating a new context that excludes irrelevant context accumulated after the fork point.

### Strategy Summary

| Mechanism | Purpose |
|---|---|
| `/compact` | Manual context compression |
| Auto-compaction | Triggered at ~75% utilization |
| Subagents/Sidechains | Isolated context for parallel work |
| Rewind/Fork | Branching to shed irrelevant context |
| CLAUDE.md | Stable instructions outside conversation window |
| Memory files | Persistent knowledge without context cost |

**Sources:**
- [How Claude Code Got Better by Protecting More Context](https://hyperdev.matsuoka.com/p/how-claude-code-got-better-by-protecting)
- [Context editing - Claude API Docs](https://platform.claude.com/docs/en/build-with-claude/context-editing)
- [Compaction - Claude API Docs](https://platform.claude.com/docs/en/build-with-claude/compaction)
- [Context Management with Subagents](https://www.richsnapp.com/article/2025/10-05-context-management-with-subagents-in-claude-code)

---

## 5. Subagents and Task Tool Architecture

### Subagent Types

Subagents are separate agent instances spawned by the main agent. Each has:
- Its own context window and execution loop
- Custom system prompt
- Specific tool access and independent permissions
- Own session transcript (`agent-<shortId>.jsonl`)

### Task Tool Flow

1. Main agent invokes Task tool with a prompt
2. Sub-agent spawns with isolated context
3. Sub-agent executes autonomously (reading files, running commands, etc.)
4. Only the final result/summary returns to the parent context
5. All intermediate tool calls stay in the sub-agent's context

### Custom Subagents

Custom subagents can be defined in `.claude/agents/` or via `--agents` flag with:
- Name, description
- System prompt (instructions)
- Allowed tools list
- Model selection

### Session Data for Subagents

Sub-agent transcripts are stored alongside the parent session as `agent-<shortId>.jsonl` in the same project directory. They inherit the parent session ID for correlation.

**Sources:**
- [Create custom subagents - Claude Code Docs](https://code.claude.com/docs/en/sub-agents)
- [The Task Tool: Agent Orchestration System](https://dev.to/bhaidar/the-task-tool-claude-codes-agent-orchestration-system-4bf2)
- [Subagents in the SDK](https://platform.claude.com/docs/en/agent-sdk/subagents)

---

## 6. Agent SDK (Programmatic API)

### SDK Options

The Agent SDK (formerly "Claude Code SDK") is available as:
- CLI (`claude -p`)
- Python package (`claude-agent-sdk-python`)
- TypeScript package

### Session Management in SDK

```python
# Continue most recent session
options = ClaudeAgentOptions(continue_session=True)

# Resume specific session
options = ClaudeAgentOptions(resume="<session-id>")

# Fork session (copy history, then diverge)
options = ClaudeAgentOptions(fork="<session-id>")
```

### Streaming Events

With `--output-format stream-json`, each line is a JSON event:

| Event Type | Description |
|---|---|
| `stream_event` with `text_delta` | Token-by-token text output |
| `system/api_retry` | Retry notification with attempt count, delay, error type |

### JSON Output Schema

With `--output-format json`, the response includes:
- `result` -- text result
- `session_id` -- session identifier for continuation
- `structured_output` -- present when `--json-schema` is provided

### Analytics API

The Claude Code Analytics Admin API provides daily aggregated metrics:
- Sessions, lines of code added/removed, commits, PRs
- Tool acceptance/rejection rates (Edit, Write, NotebookEdit)
- Estimated costs and token usage by model
- Cursor-based pagination, up to 1-hour delay

**Sources:**
- [Run Claude Code programmatically](https://code.claude.com/docs/en/headless)
- [Agent SDK overview](https://platform.claude.com/docs/en/agent-sdk/overview)
- [Work with sessions - Agent SDK](https://platform.claude.com/docs/en/agent-sdk/sessions)
- [Claude Code Analytics API](https://platform.claude.com/docs/en/build-with-claude/claude-code-analytics-api)

---

## 7. MCP TypeScript SDK (@modelcontextprotocol/sdk)

### Server Setup

```typescript
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer({ name: 'my-server', version: '1.0.0' });
```

### Tools

Register tools with Zod schemas for input validation:

```typescript
server.registerTool(
  'tool-name',
  {
    title: 'Tool Title',
    description: 'What this tool does',
    inputSchema: z.object({ param: z.string() }),
    outputSchema: z.object({ result: z.string() })  // optional
  },
  async ({ param }) => ({
    content: [{ type: 'text', text: 'result' }],
    structuredContent: { result: 'value' }  // optional
  })
);
```

Error responses use `isError: true`:
```typescript
return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
```

Tools can be dynamically managed via `registerTool()`, `remove()`, `enable()`, `disable()`, `update()` -- all trigger automatic client notifications.

### Resources

**Static resources** at fixed URIs:
```typescript
server.registerResource('config', 'config://app', { title: 'Config', mimeType: 'text/plain' },
  async (uri) => ({ contents: [{ uri: uri.href, text: 'data' }] })
);
```

**Dynamic resources** with URI templates:
```typescript
server.registerResource('session', new ResourceTemplate('session://{sessionId}', {
  list: async () => ({
    resources: sessions.map(s => ({ uri: `session://${s.id}`, name: s.name }))
  })
}), { title: 'Session', mimeType: 'application/json' },
  async (uri, { sessionId }) => ({
    contents: [{ uri: uri.href, text: JSON.stringify(getSession(sessionId)) }]
  })
);
```

### Resource Subscriptions

Clients can subscribe to resource changes:
```typescript
await server.server.sendResourceUpdated({ uri: resourceUri });
```

List changes (add/remove) are notified automatically when using `registerResource()`, `remove()`, `enable()`, `disable()`.

### Prompts

```typescript
server.registerPrompt('prompt-name', {
  title: 'Prompt Title',
  argsSchema: z.object({ code: z.string() })
}, ({ code }) => ({
  messages: [{ role: 'user', content: { type: 'text', text: `Review: ${code}` } }]
}));
```

### Transports

| Transport | Use Case |
|---|---|
| `StdioServerTransport` | Local process-spawned integrations |
| `NodeStreamableHTTPServerTransport` | Remote HTTP servers (Express, Hono) |

Stateless mode: `sessionIdGenerator: undefined`
Stateful mode: provide a session ID generator function
JSON response mode: `enableJsonResponse: true` (disables SSE)

### Argument Completions

Both prompts and resources support autocomplete via the `completable()` wrapper on Zod schemas.

**Sources:**
- [MCP TypeScript SDK - GitHub](https://github.com/modelcontextprotocol/typescript-sdk)
- [Server documentation](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md)
- [MCP TypeScript SDK docs](https://ts.sdk.modelcontextprotocol.io/)
- [@modelcontextprotocol/sdk - npm](https://www.npmjs.com/package/@modelcontextprotocol/sdk)

---

## 8. Community Projects

### Transcript Viewers and Exporters

| Project | Description | URL |
|---|---|---|
| **claude-code-transcripts** (simonw) | Convert JSONL sessions to paginated HTML with commit timeline | [GitHub](https://github.com/simonw/claude-code-transcripts) |
| **claude-JSONL-browser** (withLinda) | Web-based JSONL-to-Markdown converter with file explorer | [GitHub](https://github.com/withLinda/claude-JSONL-browser) |
| **claude-code-log** (daaain) | Python CLI converting JSONL to readable HTML | [GitHub](https://github.com/daaain/claude-code-log) |
| **claude-conversation-extractor** | Python tool to extract clean logs from internal storage; handles base64 content | [GitHub](https://github.com/ZeroSumQuant/claude-conversation-extractor) |
| **claude-code-exporter** | CLI + MCP server for exporting/aggregating conversations with filtering | [npm](https://www.npmjs.com/package/claude-code-exporter) |

### VS Code Extensions

- **agsoft.claude-history-viewer** -- Visual browsing of sessions with diffs, search, and one-click resumption

### Related MCP Servers

- **claude-code-exporter** can run as an MCP server (`npx claude-code-exporter mcp`) exposing conversation export as tools
- The official [MCP servers repository](https://github.com/modelcontextprotocol/servers) contains many community servers, though none specifically for Claude Code session data at time of writing

**Sources:**
- [claude-code-transcripts](https://github.com/simonw/claude-code-transcripts)
- [claude-JSONL-browser](https://github.com/withLinda/claude-JSONL-browser)
- [claude-conversation-extractor](https://github.com/ZeroSumQuant/claude-conversation-extractor)
- [Claude Code Exporter on LobeHub](https://lobehub.com/mcp/developerisnow-claude-code-exporter)

---

## 9. Key Insights for MCP Server Design

Based on this research, an MCP server interfacing with Claude Code session data should consider:

### Data Access Patterns

1. **Session listing** -- Parse `sessions-index.json` for metadata (summaries, timestamps, branches, message counts) without reading full JSONL files
2. **Session reading** -- Stream JSONL line-by-line; each line is independently valid JSON
3. **Global history** -- `~/.claude/history.jsonl` provides a cross-project prompt index
4. **Memory access** -- `memory/` directories contain auto-generated observations per project
5. **File history** -- `file-history/<sessionId>/` contains versioned file backups

### Resource URI Design Ideas

```
session://{projectPath}/{sessionId}           # Full session transcript
session://{projectPath}/{sessionId}/messages   # Messages only
session://{projectPath}/{sessionId}/tools      # Tool calls only
project://{projectPath}/index                  # Session index for a project
project://{projectPath}/memory                 # Auto-memory content
history://global                               # Global prompt history
```

### Tool Design Ideas

- `list-sessions` -- List sessions with filtering (by project, branch, date range)
- `read-session` -- Read a specific session's transcript (with optional filtering by event type)
- `search-sessions` -- Full-text search across session content
- `get-session-stats` -- Token usage, duration, tool counts for a session
- `read-memory` -- Access project auto-memory files
- `list-file-changes` -- List files modified in a session with version history

### Important Considerations

- JSONL files can be large; stream/paginate rather than loading entirely
- The format is undocumented by Anthropic and may change between versions
- Base64 encoding is used for some content blocks
- Sub-agent transcripts need correlation via session ID
- The `sessions-index.json` is the fastest path to session metadata
- File paths use platform-specific encoding (dashes replacing non-alphanumeric chars)
