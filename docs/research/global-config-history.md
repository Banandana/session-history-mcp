# Claude Code Global Configuration & Data Structures

Research conducted 2026-03-30 against Claude Code v2.1.87 on this machine.

---

## 1. Directory Overview: `~/.claude/`

```
~/.claude/
  CLAUDE.md                    # Global user instructions (loaded into every session)
  .credentials.json            # Auth credentials (600 perms)
  settings.json                # Global settings (model, plugins, effort, etc.)
  settings.local.json          # Local-only settings (permissions, hooks)
  stats-cache.json             # Aggregated usage statistics
  history.jsonl                # Global command history (user prompts only)
  mcp-needs-auth-cache.json    # MCP servers needing re-auth
  backups/                     # Rolling backups of .claude.json (per-session state)
  cache/                       # Cached data (changelog.md, etc.)
  debug/                       # Debug log files per session
  file-history/                # File version snapshots (undo system)
  ide/                         # IDE integration (empty if CLI-only)
  mcp-servers/                 # MCP server configurations
  paste-cache/                 # Clipboard paste content cache
  plans/                       # Session plan files
  plugins/                     # Plugin system (installed plugins, marketplaces, cache)
  projects/                    # Per-project config, sessions, memory
  scripts/                     # User hook scripts
  session-env/                 # Environment snapshots per session
  sessions/                    # Active session PID registry
  shell-snapshots/             # Shell environment snapshots
  statsig/                     # Feature flag evaluations (Statsig SDK)
  tasks/                       # Background task state
  telemetry/                   # Failed telemetry event queue
  todos/                       # Todo items per session/agent
```

---

## 2. `history.jsonl` -- Global Command History

**Location:** `~/.claude/history.jsonl`
**Format:** JSONL (one JSON object per line)
**Size observed:** 4,041 entries, ~1 MB
**Purpose:** Records every user prompt/command across all projects and sessions.

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `display` | string | Yes | The full text the user typed or pasted. Includes slash commands (`/cost`, `/login`, `/compact`, `/resume`), freeform prompts, and multi-line content. |
| `pastedContents` | object | Yes | Map of pasted content blocks. Empty `{}` when no paste. Keys are numeric string IDs (e.g., `"1"`). Values are objects with `{id, type, content}`. |
| `timestamp` | number | Yes | Unix timestamp in milliseconds. |
| `project` | string | Yes | Absolute path to the working directory/project. Examples: `/home/kitty/Desktop/flow`, `/home/kitty/Desktop/mayhem-firmware`. |
| `sessionId` | string | No | UUID of the session. **Absent in older entries** (pre-session-tracking). Present in 2,653 of 4,041 entries; absent in 1,388. |

### Key observations

- **Only user input is recorded.** Assistant responses are NOT in history.jsonl. This is purely the command/prompt log.
- **Slash commands** appear as-is: `/cost`, `/login`, `/compact`, `/resume`.
- **Multi-line prompts** are stored as single strings with `\n` escapes.
- **pastedContents** format when non-empty:
  ```json
  {
    "1": {
      "id": 1,
      "type": "text",
      "content": "...pasted text content..."
    }
  }
  ```
  148 of 4,041 entries have non-empty pastedContents.
- **sessionId was added later.** Older entries (first ~1,388) lack it. The field appears consistently in newer entries.
- **project** is always an absolute filesystem path. Over 48 unique project paths observed.
- **Timestamps** span from Oct 2025 (`1759550033201`) to Mar 2026 (`1774907740563`).
- **File is append-only** and appears capped at ~1 MB (1,048,598 bytes exactly = 1 MiB cap).

### Relationship to sessions

Each entry's `sessionId` (when present) matches a session UUID used in:
- `projects/<project-slug>/<sessionId>.jsonl` (full conversation log)
- `file-history/<sessionId>/` (file version backups)
- `session-env/<sessionId>/` (environment state)

---

## 3. `settings.json` -- Global Settings

**Location:** `~/.claude/settings.json`
**Format:** JSON

```json
{
  "model": "opus[1m]",
  "enabledPlugins": {
    "feature-dev@claude-code-plugins": true,
    "superpowers@superpowers-marketplace": true,
    "context7@claude-plugins-official": true,
    "github@claude-plugins-official": true,
    "clangd-lsp@claude-plugins-official": true
  },
  "effortLevel": "medium",
  "skipDangerousModePermissionPrompt": true
}
```

### Fields

| Field | Type | Description |
|-------|------|-------------|
| `model` | string | Model identifier. Format: `<model-name>[<context-window>]`. Examples: `"opus[1m]"`, `"sonnet"`. |
| `enabledPlugins` | object | Map of `"pluginId@marketplace"` to boolean enabled state. |
| `effortLevel` | string | Reasoning effort level. Values observed: `"medium"`. Likely also `"low"`, `"high"`. |
| `skipDangerousModePermissionPrompt` | boolean | Whether to skip the bypass-permissions mode confirmation. |

---

## 4. `settings.local.json` -- Local-Only Settings

**Location:** `~/.claude/settings.local.json`
**Format:** JSON
**Purpose:** Machine-specific settings that should not be shared/synced. Contains permissions and hooks.

```json
{
  "permissions": {
    "allow": [
      "WebFetch(domain:github.com)",
      "Bash(mount)",
      "Bash(pacman -Q:*)",
      "Bash(sudo mkdir:*)",
      "Bash(sudo mount:*)",
      "Bash(sudo pacman:*)"
    ],
    "deny": [],
    "ask": []
  },
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "command": "bash .claude/scripts/validate-bash.sh"
          }
        ]
      }
    ]
  }
}
```

### Permissions structure

| Field | Type | Description |
|-------|------|-------------|
| `permissions.allow` | string[] | Pre-approved tool patterns. Format: `ToolName(pattern)`. Wildcards with `*`. |
| `permissions.deny` | string[] | Explicitly denied tool patterns. |
| `permissions.ask` | string[] | Patterns that should always prompt. |

**Permission pattern format:** `ToolName(arguments)` where arguments can include:
- Exact match: `Bash(mount)`
- Prefix match: `Bash(sudo pacman:*)`
- Domain match: `WebFetch(domain:github.com)`

### Hooks structure

| Field | Type | Description |
|-------|------|-------------|
| `hooks` | object | Map of hook points to hook configurations. |
| `hooks.PreToolUse` | array | Hooks run before tool execution. |
| `hooks[].matcher` | string | Tool name to match against. |
| `hooks[].hooks` | array | List of hook actions. |
| `hooks[].hooks[].command` | string | Shell command to execute. |

**Known hook points:** `PreToolUse` (others likely exist: `PostToolUse`, `PreCommit`, etc.)

---

## 5. `stats-cache.json` -- Usage Statistics

**Location:** `~/.claude/stats-cache.json`
**Format:** JSON
**Purpose:** Aggregated usage statistics across all sessions.

### Top-level fields

| Field | Type | Description |
|-------|------|-------------|
| `version` | number | Schema version. Observed: `2`. |
| `lastComputedDate` | string | ISO date of last computation. Format: `"YYYY-MM-DD"`. |
| `dailyActivity` | array | Per-day activity summaries. |
| `dailyModelTokens` | array | Per-day token usage broken down by model. |
| `modelUsage` | object | Cumulative token usage per model. |
| `totalSessions` | number | Total session count. |
| `totalMessages` | number | Total message count across all sessions. |
| `longestSession` | object | Info about the longest session. |
| `firstSessionDate` | string | ISO timestamp of first session. |
| `hourCounts` | object | Map of hour (0-23) to session start count. |
| `totalSpeculationTimeSavedMs` | number | Time saved by speculative execution. |

### `dailyActivity[]` entry

```json
{
  "date": "2026-01-24",
  "messageCount": 4842,
  "sessionCount": 3,
  "toolCallCount": 1015
}
```

### `dailyModelTokens[]` entry

```json
{
  "date": "2026-01-24",
  "tokensByModel": {
    "claude-opus-4-5-20251101": 254672,
    "claude-sonnet-4-5-20250929": 4173
  }
}
```

### `modelUsage` per-model entry

```json
{
  "inputTokens": 358062,
  "outputTokens": 196040,
  "cacheReadInputTokens": 1195303723,
  "cacheCreationInputTokens": 41028353,
  "webSearchRequests": 0,
  "costUSD": 0,
  "contextWindow": 0,
  "maxOutputTokens": 0
}
```

### `longestSession` structure

```json
{
  "sessionId": "db63c349-8fad-42e6-a111-f6e79ab6d6c2",
  "duration": 66576815,
  "messageCount": 6959,
  "timestamp": "2026-01-25T07:09:07.913Z"
}
```
Duration is in milliseconds.

---

## 6. `session-env/` -- Session Environment State

**Location:** `~/.claude/session-env/<sessionId>/`
**Structure:** One directory per session UUID. Directories are **typically empty** (observed all sampled dirs as empty).
**Purpose:** Stores captured environment variables or env-related state for a session. Appears to be populated only when specific env snapshotting occurs. Most sessions produce an empty directory.

52 session directories observed, all empty in sampled set.

---

## 7. `shell-snapshots/` -- Shell Environment Snapshots

**Location:** `~/.claude/shell-snapshots/`
**Format:** Shell scripts (`.sh`)
**Naming:** `snapshot-bash-<timestamp>-<random>.sh`
**Purpose:** Captures the user's shell environment (functions, aliases, variables) at session start so Claude's bash tool can replicate the user's shell context.

### File format

The shell snapshot is a bash script that:
1. Unsets all aliases (`unalias -a`)
2. Recreates shell functions via base64-encoded `eval` blocks
3. Each function is individually encoded and decoded at load time

Example naming: `snapshot-bash-1774906984313-qd8h5c.sh`

Observed sizes: 3,445 - 6,620 bytes. 14 snapshots on disk, spanning Oct 2025 - Mar 2026.

Functions captured include user-defined functions (e.g., SSH shortcuts like `aurora`, `fermi`), system functions (systemd OSC context), and path manipulation helpers.

---

## 8. `file-history/` -- File Version Backup System

**Location:** `~/.claude/file-history/<sessionId>/<hash>@v<N>`
**Purpose:** Stores snapshots of files before/after edits, enabling undo functionality.

### Structure

- Top-level directories are session UUIDs (52 observed)
- Files within are named `<content-hash>@v<version-number>`
- Hash is a 16-character hex string (likely truncated SHA or similar)
- Versions are sequential integers starting at 1
- File contents are the **raw file content** at that version (not diffs)

### Example

```
file-history/105121ef-6f7a-4182-b871-cc496f1e8922/
  28c7b9832af40e88@v1    (381,797 bytes, Python script)
  28c7b9832af40e88@v2
  28c7b9832af40e88@v3
  28c7b9832af40e88@v4
  28c7b9832af40e88@v5
```

The hash identifies the file (content-addressed by original path hash), and each version is a full snapshot.

---

## 9. `debug/` -- Debug Log Files

**Location:** `~/.claude/debug/<sessionId>.txt`
**Format:** Plain text log files
**Purpose:** Detailed debug/trace logs for Claude Code sessions.

Observed files:
- 4 session debug logs ranging from 60 KB to 5.7 MB
- A `latest` symlink pointing to the most recent debug log
- Only a few sessions have debug logs (likely requires debug mode enabled)

---

## 10. `telemetry/` -- Telemetry Data

**Location:** `~/.claude/telemetry/`
**Purpose:** Queue for failed telemetry events that need retry.

### File naming

`1p_failed_events.<sessionId>.<secondaryId>.json`

Observed: Single empty file (0 bytes). Telemetry events that fail to send are queued here for retry.

---

## 11. `backups/` -- Session State Backups

**Location:** `~/.claude/backups/`
**Format:** `.claude.json.backup.<timestamp>` files
**Purpose:** Rolling backups of the active session's `.claude.json` state file.

### File naming

`.claude.json.backup.<unix-timestamp-ms>`

Observed: 5 backup files, all ~97 KB, from the current day. Backups appear to be created periodically during active sessions.

### Content structure

The backup files contain JSON with:
- `numStartups` (number) -- Total Claude Code launch count
- `installMethod` (string) -- e.g., `"native"`
- `autoUpdates` (boolean)
- `hasSeenTasksHint` (boolean)
- `hasUsedBackgroundTask` (boolean)
- `customApiKeyResponses` (object) -- `{approved: string[], denied: string[]}`
- Additional UI state and feature flags

---

## 12. `projects/` -- Per-Project Configuration & Sessions

**Location:** `~/.claude/projects/<project-slug>/`
**Slug format:** Absolute path with `/` replaced by `-`, leading `-`. Example: `/home/kitty/Desktop/mayhem-firmware` becomes `-home-kitty-Desktop-mayhem-firmware`.

21 project directories observed.

### Contents per project

| File/Dir | Description |
|----------|-------------|
| `<sessionId>.jsonl` | Full conversation log for a session in this project |
| `sessions-index.json` | Index of all sessions for this project |
| `<sessionId>/subagents/` | Subagent conversation logs (Task tool agents) |
| `memory/` | Project memory files (Markdown) |
| `settings.json` | Project-level settings override (optional) |
| `settings.local.json` | Project-level local settings override (optional) |
| `CLAUDE.md` | Project-specific instructions (optional) |

### `sessions-index.json` format

```json
{
  "version": 1,
  "entries": [
    {
      "sessionId": "37882bec-24e5-4ce5-aae0-e33d4c006f36",
      "fullPath": "/home/kitty/.claude/projects/-home-kitty-Desktop-mayhem-firmware/37882bec-24e5-4ce5-aae0-e33d4c006f36.jsonl",
      "fileMtime": 1769565701335,
      "firstPrompt": "it gets to 5",
      "summary": "PortaPack Mayhem to HackRF Pro PRALINE Firmware Port",
      "messageCount": 33,
      "created": "2026-01-28T01:40:43.205Z",
      "modified": "2026-01-28T02:01:20.147Z",
      "gitBranch": "praline-dev",
      "projectPath": "/home/kitty/Desktop/mayhem-firmware",
      "isSidechain": false
    }
  ]
}
```

#### Session index entry fields

| Field | Type | Description |
|-------|------|-------------|
| `sessionId` | string | UUID |
| `fullPath` | string | Absolute path to the session JSONL file |
| `fileMtime` | number | File modification time (unix ms) |
| `firstPrompt` | string | First user message text (or "No prompt" if cleared) |
| `summary` | string | AI-generated session summary |
| `messageCount` | number | Total messages in session |
| `created` | string | ISO timestamp of session creation |
| `modified` | string | ISO timestamp of last modification |
| `gitBranch` | string | Git branch active during session |
| `projectPath` | string | Absolute project directory path |
| `isSidechain` | boolean | Whether session was a sidechain/branch conversation |

### Session conversation JSONL format (`<sessionId>.jsonl`)

Each line is one of several entry types:

#### Type: `file-history-snapshot`

```json
{
  "type": "file-history-snapshot",
  "messageId": "<uuid>",
  "snapshot": {
    "messageId": "<uuid>",
    "trackedFileBackups": {},
    "timestamp": "2026-03-30T21:42:40.256Z"
  },
  "isSnapshotUpdate": false
}
```

#### Type: `user` (user message)

```json
{
  "parentUuid": null,
  "isSidechain": false,
  "promptId": "<uuid>",
  "type": "user",
  "message": {
    "role": "user",
    "content": "...user text..."
  },
  "uuid": "<uuid>",
  "timestamp": "2026-03-30T21:42:40.255Z",
  "permissionMode": "bypassPermissions",
  "userType": "external",
  "entrypoint": "cli",
  "cwd": "/home/kitty/Desktop/claude-session-mcp",
  "sessionId": "<uuid>",
  "version": "2.1.87",
  "gitBranch": "main"
}
```

#### Type: `assistant` (model response)

```json
{
  "parentUuid": "<previous-message-uuid>",
  "isSidechain": false,
  "message": {
    "model": "claude-opus-4-6",
    "id": "msg_...",
    "type": "message",
    "role": "assistant",
    "content": [
      {"type": "thinking", "thinking": "...", "signature": "..."},
      {"type": "tool_use", "id": "toolu_...", "name": "ToolName", "input": {...}, "caller": {"type": "direct"}},
      {"type": "text", "text": "..."}
    ],
    "stop_reason": "tool_use" | "end_turn" | null,
    "stop_sequence": null,
    "usage": {
      "input_tokens": 3,
      "cache_creation_input_tokens": 14918,
      "cache_read_input_tokens": 11877,
      "output_tokens": 147,
      "server_tool_use": {"web_search_requests": 0, "web_fetch_requests": 0},
      "service_tier": "standard",
      "cache_creation": {"ephemeral_1h_input_tokens": 14918, "ephemeral_5m_input_tokens": 0},
      "inference_geo": "",
      "speed": "standard"
    }
  },
  "requestId": "req_...",
  "type": "assistant",
  "uuid": "<uuid>",
  "timestamp": "2026-03-30T21:42:44.838Z",
  "userType": "external",
  "entrypoint": "cli",
  "cwd": "/home/kitty/Desktop/claude-session-mcp",
  "sessionId": "<uuid>",
  "version": "2.1.87",
  "gitBranch": "main"
}
```

#### Type: `user` (tool result)

```json
{
  "parentUuid": "<tool-use-message-uuid>",
  "isSidechain": false,
  "promptId": "<uuid>",
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      {"type": "tool_result", "tool_use_id": "toolu_...", "content": "...result..."}
    ]
  },
  "uuid": "<uuid>",
  "timestamp": "...",
  "toolUseResult": {"success": true, "commandName": "superpowers:brainstorming"},
  "sourceToolAssistantUUID": "<uuid>",
  "userType": "external",
  "entrypoint": "cli",
  "cwd": "...",
  "sessionId": "<uuid>",
  "version": "2.1.87",
  "gitBranch": "main"
}
```

### Conversation threading

Messages form a linked list via `parentUuid` -> `uuid`. The first message has `parentUuid: null`. `isSidechain: true` indicates branched conversations. `promptId` groups a user prompt with its response chain.

### Subagent conversations

Stored in `<sessionId>/subagents/agent-<hash>.jsonl`. Same JSONL format as main conversation but for Task tool agents. Naming: `agent-<7-char-hex>.jsonl`.

### Project memory

Stored in `<project-slug>/memory/`. Contains:
- `MEMORY.md` -- Index file
- Additional markdown files (e.g., `project_vision.md`)
- Files have YAML frontmatter with `name`, `description`, `type` fields

---

## 13. `sessions/` -- Active Session Registry

**Location:** `~/.claude/sessions/<pid>.json`
**Purpose:** Tracks currently active Claude Code processes.

### Format

```json
{
  "pid": 306013,
  "sessionId": "7e00ca46-9888-4f41-b344-18e1f9e92940",
  "cwd": "/home/kitty/KiCAD-MCP-Server",
  "startedAt": 1774775358785,
  "kind": "interactive",
  "entrypoint": "cli"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `pid` | number | OS process ID |
| `sessionId` | string | Session UUID |
| `cwd` | string | Working directory |
| `startedAt` | number | Unix timestamp ms |
| `kind` | string | Session type: `"interactive"` |
| `entrypoint` | string | How Claude was launched: `"cli"` |

---

## 14. Additional Directories

### `plans/`
Session-scoped plan tracking. Contains `<sessionId>/` directories with `.highwatermark` and `.lock` files for plan execution state.

### `tasks/`
Background task tracking. Contains `<sessionId>/` directories. Same session UUID key space.

### `todos/`
Todo items per session/agent. Files named `<sessionId>-agent-<agentId>.json`. Large directory (65K+ entries observed on this machine, spanning many sessions).

### `paste-cache/`
Cached clipboard paste content. Files named `<hash>.txt`. Content-addressed storage for pasted text to avoid duplication in history.

### `plugins/`
Plugin management system:
- `installed_plugins.json` -- List of installed plugins
- `known_marketplaces.json` -- Plugin marketplace registry
- `blocklist.json` -- Blocked plugins
- `install-counts-cache.json` -- Download counts
- `data/` -- Plugin data files
- `cache/` -- Plugin cache
- `marketplaces/` -- Marketplace metadata

### `mcp-servers/`
MCP server configuration directories. Contains subdirectories per configured server (e.g., `local-openai/`).

### `cache/`
General cache. Contains `changelog.md` (185 KB).

### `statsig/`
Statsig feature flag SDK cache:
- `statsig.cached.evaluations.<hash>` -- Cached feature flag evaluations
- `statsig.last_modified_time.evaluations` -- Cache freshness
- `statsig.session_id.<hash>` -- Analytics session ID
- `statsig.stable_id.<hash>` -- Stable device identifier

### `mcp-needs-auth-cache.json`
Tracks MCP servers that need authentication re-authorization:
```json
{"claude.ai Gmail":{"timestamp":1774906813910},"claude.ai Google Calendar":{"timestamp":1774906814019}}
```

---

## 15. CLAUDE.md Files

CLAUDE.md files are loaded as system instructions at session start. They exist at multiple levels:

| Location | Scope | Description |
|----------|-------|-------------|
| `~/.claude/CLAUDE.md` | Global | Loaded for ALL sessions across all projects |
| `<project>/.claude/CLAUDE.md` | Project (git-tracked) | Project-specific instructions |
| `~/.claude/projects/<slug>/CLAUDE.md` | Project (local) | Project-specific, not git-tracked |

The global CLAUDE.md on this machine is 17,405 bytes and contains delegation/orchestration strategies for the Claude Code agent.

---

## 16. Key ID Relationships

```
sessionId (UUID)
  |-- history.jsonl entries (via sessionId field)
  |-- projects/<slug>/<sessionId>.jsonl (full conversation)
  |-- projects/<slug>/sessions-index.json (session metadata)
  |-- projects/<slug>/<sessionId>/subagents/ (subagent logs)
  |-- file-history/<sessionId>/ (file version backups)
  |-- session-env/<sessionId>/ (environment snapshots)
  |-- sessions/<pid>.json (active process registry, via sessionId)
  |-- tasks/<sessionId>/ (background task state)
  |-- plans/<sessionId>/ (plan execution state)
  |-- todos/<sessionId>-agent-*.json (todo items)
  |-- debug/<sessionId>.txt (debug logs)

project path
  |-- history.jsonl entries (via project field)
  |-- projects/<slug>/ (derived from path, / -> -, leading -)
```

---

## 17. Data Size & Lifecycle Notes

- **history.jsonl** appears capped at exactly 1 MiB (1,048,598 bytes). Older entries are presumably rotated out.
- **file-history** can be large (one session had a 5.7 MB debug log; file snapshots of large files accumulate).
- **backups** appear to be rolling -- only 5 recent backups observed, all from the same day.
- **sessions/** entries are cleaned up when processes exit (only 4 `.json` files for active/recent sessions).
- **shell-snapshots** accumulate over time (14 snapshots spanning 6 months).
- **todos** directory can grow very large (65K dir size observed).
- **session-env** directories are created per session but typically remain empty.
