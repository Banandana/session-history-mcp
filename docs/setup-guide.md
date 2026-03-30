# Setup Guide

Get the Claude Session MCP server running on a new machine.

## Prerequisites

- **Node.js 20+** — `node --version` should show v20 or higher
- **npm** — comes with Node.js
- **Claude Code** — the CLI must be installed and have session history (JSONL files in `~/.claude/projects/`)
- **Git** — to clone the repo

Optional:
- **Local LLM** — for narrative summaries and intent analysis. Any OpenAI-compatible API (vLLM, llama.cpp, Ollama with OpenAI compat, etc.)

## Installation

```bash
# 1. Clone the repo
git clone https://github.com/Banandana/claude-session-mcp.git
cd claude-session-mcp

# 2. Install dependencies
npm install

# 3. Verify it works
npm test
```

## Register with Claude Code

Add the MCP server to your Claude Code configuration. Choose one of:

### Option A: Global (all projects)

Edit `~/.claude.json` and add under `mcpServers`:

```json
{
  "mcpServers": {
    "session-history": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/claude-session-mcp/src/server.ts"]
    }
  }
}
```

Replace `/absolute/path/to/claude-session-mcp` with the actual path where you cloned the repo.

### Option B: Per-project

Create `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "session-history": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/claude-session-mcp/src/server.ts"]
    }
  }
}
```

### Verify registration

Start Claude Code and run `/mcp` — you should see `session-history` listed as connected. Try calling a tool:

```
Use the session-history MCP to list my projects
```

The first call triggers a full index of your session history. This takes 5-10 seconds depending on how many sessions you have. Subsequent calls are fast (~100ms).

## Configure Local LLM (Optional)

The server generates narrative summaries using a local LLM. Without one, you still get heuristic topics and all metrics — just no prose summaries.

### Default configuration

The server connects to `http://10.1.10.20:30000/v1` with model `QuantTrio/MiniMax-M2.5-AWQ`. To change this, edit `src/container/modules.ts`:

```typescript
// Lines 23-24 — change these to your LLM endpoint
container.register(TOKENS.LocalLlmUrl, { useValue: 'http://localhost:8000/v1' })
container.register(TOKENS.LocalLlmModel, { useValue: 'your-model-name' })
```

### Compatible LLM providers

Any OpenAI-compatible `/v1/chat/completions` endpoint works:

- **vLLM**: `python -m vllm.entrypoints.openai.api_server --model your-model`
- **Ollama**: `ollama serve` (uses `http://localhost:11434/v1`)
- **llama.cpp server**: `./server -m model.gguf --port 8000`
- **LM Studio**: Enable the local server in settings

The LLM is used for:
- Generating 2-3 sentence session summaries (async, background)
- Intent-based session analysis when `intent` param is provided on `get_session`

If the LLM is unavailable, the server works normally — summaries just stay `null`.

## Database Location

The SQLite index is stored at `~/.claude/session-mcp-index.db`. To force a full re-index:

```bash
rm ~/.claude/session-mcp-index.db
```

The next MCP tool call will rebuild it from your JSONL session files.

## Development

```bash
npm run dev          # Hot-reload server (tsx --watch)
npm test             # Run all tests (260+ tests)
npm run test:watch   # Watch mode
```

## Available Tools

After setup, these tools are available to Claude Code:

| Tool | What it does |
|------|-------------|
| `list_sessions` | Browse sessions with topic, metrics, summary. Supports `sortBy` (recent/longest/most_turns/most_tokens/errors) and `resolution` (low/medium). |
| `get_session` | Drill into one session. Three detail levels (summary/metadata/full). `focus` (general/tools/errors/files/decisions) controls conversation lens. `intent` triggers LLM analysis. |
| `get_conversation` | Raw messages with token budgeting and windowing. `focus` adds a distilled view. |
| `search` | Full-text search across all session messages. |
| `analyze` | Aggregate patterns: error-prone sessions, tool failures, costly sessions, frequent files. |
| `list_projects` | All known projects with session counts. |
| `get_project` | Project details: CLAUDE.md, settings, memory entries. |
| `get_memory` | Cross-project memory access. |
| `get_changes` | File operations tracked across sessions. |

## Troubleshooting

**"Session not found"** — The session JSONL file exists but hasn't been indexed yet. Wait for the next `ensureFresh()` call (triggered automatically on any tool use) or delete the DB to force re-index.

**Summaries are all `null`** — The local LLM is not reachable. Check `curl http://your-llm-url/v1/models` returns a valid response. Summaries generate async (max 5 per sync cycle), so they populate gradually.

**Slow first call** — The initial full index takes 5-10 seconds for ~60 sessions. This only happens once (or after deleting the DB). Subsequent calls are ~100ms.

**Topics show garbage text** — If topics contain system protocol text (XML fragments, "Caveat:" prefixes), the topic sanitizer may need additional patterns. Edit `isNonIntentMessage()` in `src/services/topic-generator.ts`.

**MCP not connecting** — Verify the path in your MCP config is absolute and points to `src/server.ts`. Run `npx tsx src/server.ts` manually to check for startup errors.
