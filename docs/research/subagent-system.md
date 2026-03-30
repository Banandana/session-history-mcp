# Claude Code Subagent/Task System - Data Structure Documentation

Research conducted 2026-03-30 against `~/.claude/` on a live Claude Code installation (version 2.1.x).

---

## Directory Layout Overview

```
~/.claude/
  projects/
    {project-slug}/                     # e.g. "-home-kitty-Desktop-claude-session-mcp"
      memory/                           # Project-level memory files (MEMORY.md, etc.)
      {session-id}.jsonl                # Parent session conversation log
      {session-id}/                     # Session directory
        subagents/                      # Subagent conversation logs
          agent-{agentId}.jsonl         # Subagent conversation (JSONL format)
          agent-{agentId}.meta.json     # Subagent metadata (newer versions only)
        tool-results/                   # Persisted large tool outputs
          {hash}.txt                    # Truncated tool output stored here
  todos/
    {sessionId}-agent-{agentId}.json    # Todo list per agent (session or subagent)
  tasks/
    {sessionId}/                        # Task tracking per session
      {n}.json                          # Individual task files (1.json, 2.json, ...)
      .highwatermark                    # Highest task ID (integer)
      .lock                             # Lock file (empty)
  plans/                                # Plan storage (directory exists, currently empty)
```

---

## 1. Subagent Files

### Location

```
~/.claude/projects/{project-slug}/{session-id}/subagents/
```

Each subagent produces two files (in newer versions) or one file (older versions):
- `agent-{agentId}.jsonl` -- conversation log (always present)
- `agent-{agentId}.meta.json` -- metadata (present in versions >= ~2.1.80)

### Agent ID Formats

Agent IDs come in several formats based on type:

| Format | Length | Example | Type |
|--------|--------|---------|------|
| `a{hex}` | 7 chars | `a008465` | Older version agents (pre-2.1.80) |
| `a{hex}` | 17 chars | `aa713ded844f2cbf7` | Standard subagents (current) |
| `acompact-{hex}` | 15 chars | `acompact-f07c43` | Compact/context-search agents |
| `aprompt_suggestion-{hex}` | 25 chars | `aprompt_suggestion-1aaaea` | Prompt suggestion agents |

All agent IDs start with `a`.

---

## 2. Subagent Meta JSON (`.meta.json`)

Single-line JSON file. Minimal metadata about the subagent.

### Schema

```json
{
  "agentType": "<string>",
  "description": "<string>"
}
```

### Fields

| Field | Type | Description |
|-------|------|-------------|
| `agentType` | string | The type/role of the subagent |
| `description` | string | Human-readable description of the subagent's task |

### Known `agentType` Values

| Value | Description |
|-------|-------------|
| `"general-purpose"` | Default task agent |
| `"Explore"` | Exploration/research agent |
| `"feature-dev:code-explorer"` | Feature development code exploration agent |

These correspond to the `subagent_type` parameter passed to the `Agent` tool.

### Examples

```json
{"agentType":"Explore","description":"Read CLAUDE.md sections to update"}
{"agentType":"general-purpose","description":"Audit files for LLM commentary"}
{"agentType":"feature-dev:code-explorer","description":"Investigate batch_delete global_label bug"}
```

**Note:** Older versions (pre-2.1.80) do not produce `.meta.json` files. The 7-character agent IDs correspond to this older format.

---

## 3. Subagent JSONL Conversation Log (`.jsonl`)

Each line is a JSON object representing one message in the subagent's conversation. The format mirrors the parent session JSONL but with `isSidechain: true`.

### Message Types

#### User Message (initial prompt or tool result)

```json
{
  "parentUuid": "<string|null>",
  "isSidechain": true,
  "promptId": "<uuid>",
  "agentId": "<string>",
  "type": "user",
  "message": {
    "role": "user",
    "content": "<string|array>"
  },
  "uuid": "<uuid>",
  "timestamp": "<ISO-8601>",
  "userType": "external",
  "entrypoint": "cli",
  "cwd": "<string>",
  "sessionId": "<uuid>",
  "version": "<string>",
  "gitBranch": "<string>",
  "slug": "<string>"
}
```

#### Assistant Message (model response)

```json
{
  "parentUuid": "<uuid>",
  "isSidechain": true,
  "agentId": "<string>",
  "message": {
    "model": "<string>",
    "id": "<string>",
    "type": "message",
    "role": "assistant",
    "content": [
      {"type": "text", "text": "<string>"},
      {"type": "tool_use", "id": "<string>", "name": "<string>", "input": {}}
    ],
    "stop_reason": "<string|null>",
    "stop_sequence": null,
    "usage": {
      "input_tokens": "<int>",
      "cache_creation_input_tokens": "<int>",
      "cache_read_input_tokens": "<int>",
      "output_tokens": "<int>",
      "server_tool_use": {
        "web_search_requests": "<int>",
        "web_fetch_requests": "<int>"
      },
      "service_tier": "standard",
      "cache_creation": {
        "ephemeral_1h_input_tokens": "<int>",
        "ephemeral_5m_input_tokens": "<int>"
      },
      "inference_geo": "<string>",
      "iterations": [],
      "speed": "standard"
    }
  },
  "requestId": "<string>",
  "type": "assistant",
  "uuid": "<uuid>",
  "timestamp": "<ISO-8601>",
  "userType": "external",
  "entrypoint": "cli",
  "cwd": "<string>",
  "sessionId": "<uuid>",
  "version": "<string>",
  "gitBranch": "<string>",
  "slug": "<string>"
}
```

#### Tool Result Message

```json
{
  "parentUuid": "<uuid>",
  "isSidechain": true,
  "promptId": "<uuid>",
  "agentId": "<string>",
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      {
        "type": "tool_result",
        "content": "<string>",
        "is_error": "<boolean>",
        "tool_use_id": "<string>"
      }
    ]
  },
  "uuid": "<uuid>",
  "timestamp": "<ISO-8601>",
  "toolUseResult": "<string|object>",
  "sourceToolAssistantUUID": "<uuid>",
  "userType": "external",
  "entrypoint": "cli",
  "cwd": "<string>",
  "sessionId": "<uuid>",
  "version": "<string>",
  "gitBranch": "<string>",
  "slug": "<string>"
}
```

### Key Fields on All Messages

| Field | Type | Description |
|-------|------|-------------|
| `parentUuid` | string/null | UUID of the previous message in the conversation chain. `null` for the first message. |
| `isSidechain` | boolean | Always `true` for subagent messages. Always `false` for parent session messages. |
| `agentId` | string | The subagent's ID (matches the filename). |
| `type` | string | `"user"` or `"assistant"` |
| `uuid` | string | Unique identifier for this message. |
| `timestamp` | string | ISO-8601 timestamp. |
| `sessionId` | string | The **parent** session's ID (not the subagent's own ID). |
| `promptId` | string | Present on user messages. Groups messages belonging to the same prompt/response cycle. |
| `slug` | string | Human-readable session slug (e.g., `"glistening-tickling-pike"`). |
| `version` | string | Claude Code version (e.g., `"2.1.87"`). |
| `cwd` | string | Working directory. |
| `gitBranch` | string | Current git branch. |
| `entrypoint` | string | Always `"cli"`. |
| `userType` | string | Always `"external"`. |

### Model Used

Subagents typically use `claude-haiku-4-5-20251001` (Haiku 4.5) as shown in the `message.model` field, while parent sessions use `claude-opus-4-6` or similar.

### Conversation Flow

1. First line: `type: "user"` with `parentUuid: null` -- the initial prompt from the parent
2. Subsequent lines alternate between `type: "assistant"` (model responses, possibly with tool_use) and `type: "user"` (tool results)
3. Last line: `type: "assistant"` with the final summary/response text
4. The `parentUuid` chain forms a linked list of the conversation

---

## 4. How Parent Sessions Spawn Subagents

### The Agent Tool Call

In the parent session JSONL, a subagent is spawned via a `tool_use` block with `name: "Agent"`:

```json
{
  "type": "tool_use",
  "id": "toolu_01GyJvwigaCUfxURamTa7B4p",
  "name": "Agent",
  "input": {
    "description": "Read CLAUDE.md sections to update",
    "prompt": "Read the file ... and report back ...",
    "subagent_type": "Explore"
  },
  "caller": {"type": "direct"}
}
```

### Agent Tool Input Fields

| Field | Type | Description |
|-------|------|-------------|
| `prompt` | string | The full prompt/instructions sent to the subagent |
| `description` | string | Short description (appears in meta.json) |
| `subagent_type` | string | Agent type (e.g., `"Explore"`, `"general-purpose"`, `"feature-dev:code-explorer"`) |

### The Tool Result in Parent Session

When the subagent completes, a `tool_result` message appears in the parent session with rich metadata in the `toolUseResult` field:

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      {
        "tool_use_id": "toolu_01GyJvwigaCUfxURamTa7B4p",
        "type": "tool_result",
        "content": [
          {"type": "text", "text": "<subagent's final summary text>"}
        ]
      }
    ]
  },
  "toolUseResult": {
    "status": "completed",
    "prompt": "<the original prompt sent to the subagent>",
    "agentId": "aa713ded844f2cbf7",
    "agentType": "Explore",
    "content": [
      {"type": "text", "text": "<subagent's final summary text>"}
    ],
    "totalDurationMs": 22217,
    "totalTokens": 85036,
    "totalToolUseCount": 16,
    "usage": {
      "input_tokens": "<int>",
      "cache_creation_input_tokens": "<int>",
      "cache_read_input_tokens": "<int>",
      "output_tokens": "<int>",
      "server_tool_use": {
        "web_search_requests": 0,
        "web_fetch_requests": 0
      },
      "service_tier": "standard",
      "cache_creation": {
        "ephemeral_1h_input_tokens": 0,
        "ephemeral_5m_input_tokens": "<int>"
      }
    }
  },
  "sourceToolAssistantUUID": "<uuid-of-the-assistant-message-that-spawned-this>"
}
```

### `toolUseResult` Schema

| Field | Type | Description |
|-------|------|-------------|
| `status` | string | `"completed"` (possibly other values for failures) |
| `prompt` | string | The original prompt sent to the subagent |
| `agentId` | string | The subagent's agent ID |
| `agentType` | string | The subagent's type |
| `content` | array | The subagent's final response content blocks |
| `totalDurationMs` | int | Total wall-clock time for the subagent |
| `totalTokens` | int | Total tokens used by the subagent |
| `totalToolUseCount` | int | Number of tool calls the subagent made |
| `usage` | object | Detailed token usage breakdown |

### Linking Parent to Subagent

- **Parent -> Subagent**: The `agentId` in `toolUseResult` matches the subagent's filename and `agentId` field in the subagent JSONL.
- **Subagent -> Parent**: The `sessionId` in the subagent JSONL matches the parent session's ID. The `sourceToolAssistantUUID` in the parent's tool_result points to the assistant message that issued the `Agent` tool call.
- **`promptId`**: Shared between the subagent's user messages and the parent's tool_result message. Groups related messages across parent and subagent.

---

## 5. Special Subagent Types

### Compact Agents (`acompact-{hex}`)

These appear to be context-search/grep agents. Their first message includes a `toolUseResult` with search results directly in the user message (no separate prompt). They seem to be automatically spawned for context gathering rather than user-requested.

### Prompt Suggestion Agents (`aprompt_suggestion-{hex}`)

These are internal agents that predict what the user might type next. Their initial prompt starts with `[SUGGESTION MODE: Suggest what the user might naturally type next...]`. These are UI/UX agents, not user-visible.

---

## 6. Todos Directory (`~/.claude/todos/`)

### Location and Naming

```
~/.claude/todos/{sessionId}-agent-{agentId}.json
```

The naming pattern is: `{sessionId}-agent-{agentId}.json` where:
- For the **main session agent**: `agentId` equals `sessionId` (e.g., `029c2cab...-agent-029c2cab....json`)
- For **subagents**: `agentId` is a different UUID (e.g., `029c2cab...-agent-0e5abd6c....json`)

### Schema

The file contains a JSON array of todo items:

```json
[
  {
    "content": "<string>",
    "status": "<string>",
    "activeForm": "<string>"
  }
]
```

### Fields

| Field | Type | Description |
|-------|------|-------------|
| `content` | string | The todo item description (imperative/task form) |
| `status` | string | One of: `"pending"`, `"in_progress"`, `"completed"` |
| `activeForm` | string | Present-participle/gerund form of the task (used for UI display) |

### Examples

```json
[
  {
    "content": "Verify IOC PA5 configuration is correct",
    "status": "in_progress",
    "activeForm": "Checking IOC file"
  },
  {
    "content": "Verify HAL MSP generates correct PA5 GPIO init",
    "status": "pending",
    "activeForm": "Checking HAL MSP"
  }
]
```

```json
[
  {
    "content": "Install essential packages",
    "status": "completed",
    "activeForm": "Installing essential packages"
  },
  {
    "content": "Configure NFS server",
    "status": "in_progress",
    "activeForm": "Configuring NFS server"
  }
]
```

### Notes

- Empty todo lists are stored as `[]` (2 bytes).
- There are ~410 unique session IDs with todo files.
- Most todo files are empty (`[]`). Non-empty files contain 3-13 items typically.
- The `activeForm` is always a gerund phrase describing what's currently happening for that step.

---

## 7. Tasks Directory (`~/.claude/tasks/`)

### Location and Structure

```
~/.claude/tasks/{sessionId}/
  .lock           # Empty lock file for concurrency control
  .highwatermark  # Contains highest task ID as plain integer (e.g., "5")
  1.json          # Task file
  2.json          # Task file
  ...
```

Tasks are organized by **session ID** (not project). Each task is a numbered JSON file.

### Task Schema

```json
{
  "id": "<string>",
  "subject": "<string>",
  "description": "<string>",
  "activeForm": "<string>",
  "status": "<string>",
  "blocks": [],
  "blockedBy": []
}
```

### Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Numeric ID as string (matches filename without `.json`) |
| `subject` | string | Short description of the task |
| `description` | string | Detailed description (often empty) |
| `activeForm` | string | Past-tense or active description of the task state |
| `status` | string | One of: `"pending"`, `"in_progress"`, `"completed"` |
| `blocks` | array | IDs of tasks this task blocks (dependency graph) |
| `blockedBy` | array | IDs of tasks that block this task |

### Examples

```json
{
  "id": "1",
  "subject": "Fix w25q80bv.c flash size detection",
  "description": "",
  "activeForm": "Fixed flash size detection",
  "status": "completed",
  "blocks": [],
  "blockedBy": []
}
```

```json
{
  "id": "3",
  "subject": "Found root cause: cpld::load_sram() called on PRALINE",
  "description": "",
  "activeForm": "Found root cause",
  "status": "completed",
  "blocks": [],
  "blockedBy": []
}
```

### `.highwatermark`

Plain text file containing a single integer -- the highest task ID that has been created. Used to generate the next task ID.

### `.lock`

Empty file used for filesystem-level locking during concurrent access.

### Tasks vs Todos

| Aspect | Todos | Tasks |
|--------|-------|-------|
| Location | `~/.claude/todos/` | `~/.claude/tasks/` |
| Scope | Per agent (session or subagent) | Per session |
| Format | Single JSON array file | Individual numbered JSON files |
| Dependencies | None | `blocks`/`blockedBy` arrays |
| ID | Implicit (array index) | Explicit numeric ID |
| Naming | `{sessionId}-agent-{agentId}.json` | `{sessionId}/{n}.json` |
| Purpose | Lightweight checklist for current work | Structured task tracking with dependencies |

---

## 8. Plans Directory (`~/.claude/plans/`)

The directory exists but was **empty** at time of research. Plans may be stored ephemerally or in a different location. The plans feature is available via skills (`superpowers:writing-plans`, `superpowers:executing-plans`) but the actual plan storage mechanism was not observable from disk.

---

## 9. Parent Session JSONL Format

The parent session file is at:
```
~/.claude/projects/{project-slug}/{session-id}.jsonl
```

### Message Types in Parent Session

#### `file-history-snapshot`
First entry in many sessions. Tracks file state for undo/restore:
```json
{
  "type": "file-history-snapshot",
  "messageId": "<uuid>",
  "snapshot": {
    "messageId": "<uuid>",
    "trackedFileBackups": {},
    "timestamp": "<ISO-8601>"
  },
  "isSnapshotUpdate": false
}
```

#### `user` (parent)
```json
{
  "parentUuid": "<uuid|null>",
  "isSidechain": false,
  "type": "user",
  "message": {"role": "user", "content": "<string|array>"},
  "uuid": "<uuid>",
  "timestamp": "<ISO-8601>",
  ...
}
```

#### `assistant` (parent)
Same structure as subagent but with `isSidechain: false` and no `agentId`.

### Key Difference: `isSidechain`

- Parent session messages: `isSidechain: false`, no `agentId`
- Subagent messages: `isSidechain: true`, has `agentId`

---

## 10. ID Relationships Summary

```
Project Slug (path-based)
  └── Session ID (UUID v4)
        ├── Parent JSONL: {sessionId}.jsonl (isSidechain: false)
        ├── Session Dir: {sessionId}/
        │     └── subagents/
        │           ├── agent-{agentId}.jsonl (isSidechain: true, sessionId = parent)
        │           └── agent-{agentId}.meta.json
        ├── Todos: ~/.claude/todos/{sessionId}-agent-{sessionId}.json  (main agent)
        ├── Todos: ~/.claude/todos/{sessionId}-agent-{subagentId}.json (subagents)
        └── Tasks: ~/.claude/tasks/{sessionId}/*.json
```

Key relationships:
- **Session ID** is the UUID of the parent session and appears everywhere
- **Agent ID** identifies a specific subagent within a session
- **For the main session agent**, the agent ID in todos equals the session ID
- **`promptId`** links related messages across parent and subagent JSONL files
- **`sourceToolAssistantUUID`** in parent tool_result points to the assistant message that spawned the subagent
- **`parentUuid`** chains messages within a single JSONL file (linked list)

---

## 11. Tool Results Directory

```
~/.claude/projects/{project-slug}/{session-id}/tool-results/{hash}.txt
```

When tool output exceeds a size threshold, the full output is saved to this directory and a truncated preview is shown in the JSONL. The persisted output message in the JSONL looks like:

```
Output too large (35.9KB). Full output saved to: /home/kitty/.claude/projects/{slug}/{sessionId}/tool-results/{hash}.txt
```

---

## 12. Version Differences

| Feature | Older (~2.1.22) | Current (~2.1.87) |
|---------|-----------------|---------------------|
| Agent ID length | 7 chars (`a008465`) | 17 chars (`aa713ded844f2cbf7`) |
| `.meta.json` files | Not present | Present |
| `slug` field | Sometimes present | Always present |
| `promptId` field | Not always present | Present on user messages |
| `toolUseResult` in parent | Simpler format | Rich metadata with usage stats |

---

## 13. Data Access Patterns for MCP Server

### To list all subagents for a session:
```
~/.claude/projects/{project-slug}/{session-id}/subagents/agent-*.meta.json
```

### To get subagent conversation:
```
~/.claude/projects/{project-slug}/{session-id}/subagents/agent-{agentId}.jsonl
```

### To find parent session for a subagent:
Read the `sessionId` field from any line in the subagent's JSONL.

### To get todos for an agent:
```
~/.claude/todos/{sessionId}-agent-{agentId}.json
```

### To get tasks for a session:
```
~/.claude/tasks/{sessionId}/*.json
```

### To enumerate all sessions for a project:
```
~/.claude/projects/{project-slug}/*.jsonl
```

### To find which project a session belongs to:
Search for `{sessionId}.jsonl` across all project directories, or read `cwd` from the first user message in the session JSONL.
