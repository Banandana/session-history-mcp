# Setup Guide

Get the Session History MCP server running on a new machine.

## Prerequisites

- **Node.js 20+** — `node --version` should show v20 or higher
- **npm** — comes with Node.js
- **Claude Code** — the CLI must be installed and have session history (JSONL files in `~/.claude/projects/`)
- **Git** — to clone the repo

Optional:
- **Local LLM** — for narrative summaries and intent analysis. Any OpenAI-compatible API (SGLang, llama.cpp, Ollama with OpenAI compat, etc.)

## Installation

```bash
# 1. Clone the repo
git clone https://github.com/Banandana/session-history-mcp.git
cd session-history-mcp

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
      "args": ["tsx", "/absolute/path/to/session-history-mcp/src/server.ts"]
    }
  }
}
```

Replace `/absolute/path/to/session-history-mcp` with the actual path where you cloned the repo.

### Option B: Per-project

Create `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "session-history": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/session-history-mcp/src/server.ts"]
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

- **SGLang**: `python -m sglang.launch_server --model your-model`
- **Ollama**: `ollama serve` (uses `http://localhost:11434/v1`)
- **llama.cpp server**: `./server -m model.gguf --port 8000`
- **LM Studio**: Enable the local server in settings

For embeddings (`semantic_search`), any OpenAI-compatible `/v1/embeddings`
endpoint works — e.g. **TEI** (`text-embeddings-inference`) for ModernBERT.

The LLM is used for:
- Generating 2-3 sentence session summaries (async, background)
- Deep session analysis via `deep_analyze` (requires Anthropic API key)

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
| `list_projects` | All known projects with session counts, memory presence, branch activity |
| `get_project` | Project deep-dive — CLAUDE.md, settings, memory entries, session list |
| `list_sessions` | Sessions filtered by project, date, branch, with sorting |
| `get_session` | Session metadata at three detail levels: summary, metadata (tools/files/subagents), full (with LLM analysis) |
| `get_conversation` | Phase-clustered session overview — groups turns by activity category |
| `query_turns` | Search turns by tool name, error/correction status, text pattern, time range |
| `get_turns` | Full content expansion for specific turns — tool inputs, outputs, text, token usage |
| `search` | Full-text search across all indexed sessions |
| `get_changes` | File operations tracked across sessions |
| `get_memory` | Cross-project memory access |
| `analyze` | Aggregate pattern discovery — errors, corrections, tool failures, costly sessions |
| `deep_analyze` | Send entire session to Opus for comprehensive quality analysis |

## Troubleshooting

**"Session not found"** — The session JSONL file exists but hasn't been indexed yet. Wait for the next `ensureFresh()` call (triggered automatically on any tool use) or delete the DB to force re-index.

**Summaries are all `null`** — The local LLM is not reachable. Check `curl http://your-llm-url/v1/models` returns a valid response. Summaries generate async (max 5 per sync cycle), so they populate gradually.

**Slow first call** — The initial full index takes 5-10 seconds for ~60 sessions. This only happens once (or after deleting the DB). Subsequent calls are ~100ms.

**Topics show garbage text** — If topics contain system protocol text (XML fragments, "Caveat:" prefixes), the topic sanitizer may need additional patterns. Edit `isNonIntentMessage()` in `src/services/topic-generator.ts`.

**MCP not connecting** — Verify the path in your MCP config is absolute and points to `src/server.ts`. Run `npx tsx src/server.ts` manually to check for startup errors.
