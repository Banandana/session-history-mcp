# Claude Code Session Storage Format

Research based on analysis of actual session files on a live system running Claude Code v2.1.79-2.1.87.

## Directory Structure

```
~/.claude/
  history.jsonl                          # Global prompt history (input log)
  sessions/
    {pid}.json                           # Active session metadata (keyed by OS PID)
  projects/
    {project-slug}/
      memory/                            # Project memory files (markdown)
      sessions-index.json                # Session index with summaries
      {session-id}.jsonl                 # Session conversation log
      {session-id}/                      # Session artifacts directory
        subagents/
          agent-{agent-id}.jsonl         # Subagent conversation log
          agent-{agent-id}.meta.json     # Subagent metadata
  file-history/
    {session-id}/
      {hash}@v{N}                        # File backup snapshots
  tasks/
    {session-id}/                        # Task agent data (if any)
```

## Project Slug Naming Convention

The project slug is the absolute path to the project directory with `/` replaced by `-` and leading `/` replaced by `-`:

```
/home/kitty/Desktop/mayhem-firmware  -->  -home-kitty-Desktop-mayhem-firmware
/home/kitty/Desktop/ginny-decoder    -->  -home-kitty-Desktop-ginny-decoder
/home/kitty                          -->  -home-kitty
```

Rule: Replace every `/` with `-`, resulting in a leading `-`.

## Session IDs

Session IDs are standard UUIDv4 strings:
```
460044e4-c0c7-4cdd-b03c-652a2f37219f
3d8de6c2-d484-460d-ac66-ae4776fce1d9
ad78fda3-eeb0-43b6-ba9a-c57270b29c94
```

These IDs are used consistently across:
- The JSONL filename: `{session-id}.jsonl`
- The `sessionId` field in every JSONL line
- The session metadata in `sessions/{pid}.json`
- The `sessions-index.json` entries
- The `file-history/{session-id}/` directory
- The `tasks/{session-id}/` directory

## Session Metadata: `sessions/{pid}.json`

Maps a running OS process to its session. File is named by PID and deleted when the process ends.

```json
{
  "pid": 776065,
  "sessionId": "460044e4-c0c7-4cdd-b03c-652a2f37219f",
  "cwd": "/home/kitty/Desktop/claude-session-mcp",
  "startedAt": 1774906813407,
  "kind": "interactive",
  "entrypoint": "cli"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `pid` | number | OS process ID |
| `sessionId` | string (UUID) | Links to the JSONL file |
| `cwd` | string | Working directory at session start |
| `startedAt` | number | Unix timestamp in milliseconds |
| `kind` | string | `"interactive"` observed |
| `entrypoint` | string | `"cli"` observed |

## Sessions Index: `sessions-index.json`

Per-project index of all sessions with metadata for quick listing.

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

| Field | Type | Description |
|-------|------|-------------|
| `sessionId` | string (UUID) | Session identifier |
| `fullPath` | string | Absolute path to the JSONL file |
| `fileMtime` | number | File modification time (Unix ms) |
| `firstPrompt` | string | First user message text (or "No prompt") |
| `summary` | string | AI-generated session summary |
| `messageCount` | number | Total JSONL lines in the session |
| `created` | string (ISO 8601) | Session creation timestamp |
| `modified` | string (ISO 8601) | Last modification timestamp |
| `gitBranch` | string | Git branch active during session |
| `projectPath` | string | Absolute path to the project |
| `isSidechain` | boolean | Whether this is a sidechain session |

## JSONL Line Format

Each line in a session JSONL file is a self-contained JSON object. Lines are appended in chronological order. Every line has a `type` field.

### Message Types

| Type | Description |
|------|-------------|
| `user` | User message or tool result |
| `assistant` | Assistant response (streamed in chunks) |
| `system` | System metadata (turn duration, etc.) |
| `progress` | Progress indicators (hooks, agents, search) |
| `file-history-snapshot` | File backup checkpoint |
| `queue-operation` | User message queue operations |

---

## Type: `user`

Two variants: direct user input and tool results.

### Variant 1: User Text Input

```json
{
  "parentUuid": null,
  "isSidechain": false,
  "promptId": "b35ed940-1222-4d7d-a390-31dce2a583b5",
  "type": "user",
  "message": {
    "role": "user",
    "content": "i need to flash the mayhem firmware"
  },
  "uuid": "6899fa30-f4d8-4e2e-beac-8eae8768d640",
  "timestamp": "2026-03-27T00:51:21.799Z",
  "permissionMode": "default",
  "userType": "external",
  "entrypoint": "cli",
  "cwd": "/home/kitty/Desktop/mayhem-firmware",
  "sessionId": "ad78fda3-eeb0-43b6-ba9a-c57270b29c94",
  "version": "2.1.85",
  "gitBranch": "praline-dev"
}
```

### Variant 2: Tool Result

```json
{
  "parentUuid": "cc3f2af4-16e1-4f8e-8921-46e98f06f387",
  "isSidechain": false,
  "promptId": "b35ed940-1222-4d7d-a390-31dce2a583b5",
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      {
        "tool_use_id": "toolu_0139tf6psdJWEt1L8rkYak8c",
        "type": "tool_result",
        "content": "COPY_TO_SDCARD_hackrf_mayhem_v2.4.0\n...",
        "is_error": false
      }
    ]
  },
  "uuid": "8e8f748c-fbdd-47bb-a84f-194998fd0a4b",
  "timestamp": "2026-03-27T00:51:29.658Z",
  "toolUseResult": {
    "stdout": "COPY_TO_SDCARD_hackrf_mayhem_v2.4.0\n...",
    "stderr": "",
    "interrupted": false,
    "isImage": false,
    "noOutputExpected": false
  },
  "sourceToolAssistantUUID": "cc3f2af4-16e1-4f8e-8921-46e98f06f387",
  "userType": "external",
  "entrypoint": "cli",
  "cwd": "/home/kitty/Desktop/mayhem-firmware",
  "sessionId": "ad78fda3-eeb0-43b6-ba9a-c57270b29c94",
  "version": "2.1.85",
  "gitBranch": "praline-dev",
  "slug": "precious-frolicking-stearns"
}
```

### User Message Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"user"` | yes | Message type discriminator |
| `uuid` | string (UUID) | yes | Unique ID for this message |
| `parentUuid` | string (UUID) \| null | yes | UUID of the previous message in the chain. `null` for the first message or after a progress/snapshot line. |
| `isSidechain` | boolean | yes | `true` for subagent conversations |
| `promptId` | string (UUID) | yes | Groups all messages in a single user turn (prompt + all assistant responses + tool results until next user prompt) |
| `message.role` | `"user"` | yes | Anthropic API role |
| `message.content` | string \| array | yes | String for user text; array of `tool_result` objects for tool responses |
| `timestamp` | string (ISO 8601) | yes | When the message was recorded |
| `sessionId` | string (UUID) | yes | Session this belongs to |
| `version` | string | yes | Claude Code version (e.g., `"2.1.85"`) |
| `cwd` | string | yes | Current working directory |
| `entrypoint` | string | yes | `"cli"` for terminal sessions |
| `userType` | string | yes | `"external"` observed |
| `gitBranch` | string | no | Current git branch |
| `permissionMode` | string | no | `"default"` or `"bypassPermissions"` (only on user text input, not tool results) |
| `toolUseResult` | object | no | Only on tool result messages. Contains `stdout`, `stderr`, `interrupted`, `isImage`, `noOutputExpected`. |
| `sourceToolAssistantUUID` | string (UUID) | no | Only on tool results. Points to the assistant message that requested this tool. |
| `slug` | string | no | Human-readable session name (e.g., `"precious-frolicking-stearns"`). Appears after first assistant response. |

### Tool Result Content Item

```json
{
  "tool_use_id": "toolu_0139tf6psdJWEt1L8rkYak8c",
  "type": "tool_result",
  "content": "... output text ...",
  "is_error": false
}
```

### toolUseResult Object

Present on tool result user messages. Contains the raw execution result separate from what was sent to the API.

| Field | Type | Description |
|-------|------|-------------|
| `stdout` | string | Standard output from the tool |
| `stderr` | string | Standard error from the tool |
| `interrupted` | boolean | Whether the user interrupted execution |
| `isImage` | boolean | Whether the result contains image data |
| `noOutputExpected` | boolean | Hint about expected output |

---

## Type: `assistant`

Assistant messages are **streamed as multiple JSONL lines** from a single API response. Each line contains one content block. Lines from the same API call share the same `requestId` and `message.id`.

### Streaming Pattern

A single API response produces multiple JSONL lines:

```
requestId=...SMJ5  stop=null     content=['thinking']   uuid=ae71fd54   (chunk 1: thinking)
requestId=...SMJ5  stop=tool_use content=['tool_use']   uuid=cc3f2af4   (chunk 2: tool call)
```

Or for a text response with thinking:
```
requestId=...L4pL  stop=null     content=['thinking']   uuid=536a6a4f   (chunk 1: thinking)
requestId=...L4pL  stop=null     content=['text']       uuid=82b81832   (chunk 2: text)
requestId=...L4pL  stop=tool_use content=['tool_use']   uuid=264c5189   (chunk 3: tool call)
```

**Key insight**: Each JSONL line for an assistant message contains exactly ONE content block. The `stop_reason` is `null` for intermediate chunks and set to the final reason (`"end_turn"`, `"tool_use"`) on the last chunk.

### Example: Thinking Block

```json
{
  "parentUuid": "ff9e7b60-cd39-4b5f-ab6a-b8d0fb3908cc",
  "isSidechain": false,
  "message": {
    "model": "claude-opus-4-6",
    "id": "msg_014FCireV1Kq9WuYuNkcTuYY",
    "type": "message",
    "role": "assistant",
    "content": [
      {
        "type": "thinking",
        "thinking": "",
        "signature": "EuwCClkIDBgCKkB8gsmq6o1S..."
      }
    ],
    "stop_reason": null,
    "stop_sequence": null,
    "usage": {
      "input_tokens": 3,
      "cache_creation_input_tokens": 30253,
      "cache_read_input_tokens": 11931,
      "cache_creation": {
        "ephemeral_5m_input_tokens": 0,
        "ephemeral_1h_input_tokens": 30253
      },
      "output_tokens": 33,
      "service_tier": "standard",
      "inference_geo": "not_available"
    }
  },
  "requestId": "req_011CZSfrRwsM3RmVV5YTSMJ5",
  "type": "assistant",
  "uuid": "ae71fd54-a8ab-443d-b463-de5bad46d34c",
  "timestamp": "2026-03-27T00:51:27.588Z",
  "userType": "external",
  "entrypoint": "cli",
  "cwd": "/home/kitty/Desktop/mayhem-firmware",
  "sessionId": "ad78fda3-eeb0-43b6-ba9a-c57270b29c94",
  "version": "2.1.85",
  "gitBranch": "praline-dev"
}
```

### Example: Tool Use Block

```json
{
  "parentUuid": "ae71fd54-a8ab-443d-b463-de5bad46d34c",
  "isSidechain": false,
  "message": {
    "model": "claude-opus-4-6",
    "id": "msg_01UUAwEmRNj3xPa4XZr8KtSo",
    "type": "message",
    "role": "assistant",
    "content": [
      {
        "type": "tool_use",
        "id": "toolu_0139tf6psdJWEt1L8rkYak8c",
        "name": "Bash",
        "input": {
          "command": "ls ~/Downloads/ | grep -i mayhem",
          "description": "List Mayhem firmware files in Downloads"
        },
        "caller": {
          "type": "direct"
        }
      }
    ],
    "stop_reason": "tool_use",
    "stop_sequence": null,
    "usage": { "..." : "..." }
  },
  "requestId": "req_011CZSfrRwsM3RmVV5YTSMJ5",
  "type": "assistant",
  "uuid": "cc3f2af4-16e1-4f8e-8921-46e98f06f387",
  "timestamp": "2026-03-27T00:51:28.165Z",
  "slug": "precious-frolicking-stearns",
  "..."
}
```

### Example: Text Block

```json
{
  "parentUuid": "19bd11fa-2be7-41fc-b44d-22044ae8b8eb",
  "isSidechain": false,
  "message": {
    "model": "claude-opus-4-6",
    "id": "msg_014FCireV1Kq9WuYuNkcTuYY",
    "type": "message",
    "role": "assistant",
    "content": [
      {
        "type": "text",
        "text": "Based on your project setup, the schematic file..."
      }
    ],
    "stop_reason": "end_turn",
    "stop_sequence": null,
    "usage": { "..." : "..." }
  },
  "requestId": "req_011CZCwnKDG5QS9gC1XCeJFT",
  "type": "assistant",
  "uuid": "c5c615a8-9bf7-4cd1-a62d-58c445c2a9ee",
  "timestamp": "2026-03-19T18:52:11.939Z",
  "..."
}
```

### Assistant Message Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"assistant"` | yes | Message type discriminator |
| `uuid` | string (UUID) | yes | Unique ID for this JSONL line (NOT the API message ID) |
| `parentUuid` | string (UUID) | yes | UUID of the previous JSONL line in the conversation chain |
| `isSidechain` | boolean | yes | `true` for subagent conversations |
| `requestId` | string | yes | Anthropic API request ID (e.g., `"req_011CZSfrRwsM3RmVV5YTSMJ5"`). Same for all chunks from one API call. |
| `message.model` | string | yes | Model name (e.g., `"claude-opus-4-6"`) |
| `message.id` | string | yes | Anthropic API message ID. Same for all chunks from one API call. |
| `message.type` | `"message"` | yes | Always `"message"` |
| `message.role` | `"assistant"` | yes | Anthropic API role |
| `message.content` | array | yes | Always a single-element array with one content block |
| `message.stop_reason` | string \| null | yes | `null` for intermediate chunks; `"end_turn"` or `"tool_use"` for final chunk |
| `message.stop_sequence` | null | yes | Always `null` in observed data |
| `message.usage` | object | yes | Token usage (see below) |
| `timestamp` | string (ISO 8601) | yes | When this chunk was recorded |
| `sessionId` | string (UUID) | yes | Session this belongs to |
| `version` | string | yes | Claude Code version |
| `cwd` | string | yes | Current working directory |
| `entrypoint` | string | yes | `"cli"` |
| `userType` | string | yes | `"external"` |
| `gitBranch` | string | no | Current git branch |
| `slug` | string | no | Human-readable session name. Typically appears starting from the first tool_use or end_turn chunk. |

### Content Block Types

#### `thinking`

```json
{
  "type": "thinking",
  "thinking": "",
  "signature": "EuwCClkIDBgCKkB8gsmq6..."
}
```

The `thinking` field is always empty string in the stored JSONL (extended thinking content is not persisted). The `signature` is a cryptographic verification of the thinking content.

#### `text`

```json
{
  "type": "text",
  "text": "Here is the assistant's response..."
}
```

#### `tool_use`

```json
{
  "type": "tool_use",
  "id": "toolu_0139tf6psdJWEt1L8rkYak8c",
  "name": "Bash",
  "input": {
    "command": "ls ~/Downloads/",
    "description": "List files"
  },
  "caller": {
    "type": "direct"
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Tool use ID (prefixed with `toolu_`). Referenced by the corresponding `tool_result`. |
| `name` | string | Tool name: `Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, `WebSearch`, `WebFetch`, `Task`, etc. |
| `input` | object | Tool-specific input parameters |
| `caller.type` | string | `"direct"` observed |

### Token Usage Object

```json
{
  "input_tokens": 3,
  "cache_creation_input_tokens": 30253,
  "cache_read_input_tokens": 11931,
  "cache_creation": {
    "ephemeral_5m_input_tokens": 0,
    "ephemeral_1h_input_tokens": 30253
  },
  "output_tokens": 136,
  "service_tier": "standard",
  "inference_geo": "not_available",
  "server_tool_use": {
    "web_search_requests": 0,
    "web_fetch_requests": 0
  },
  "iterations": [],
  "speed": "standard"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `input_tokens` | number | Input tokens billed (often `3` due to caching) |
| `cache_creation_input_tokens` | number | Tokens written to cache this request |
| `cache_read_input_tokens` | number | Tokens read from cache |
| `cache_creation.ephemeral_5m_input_tokens` | number | Short-lived cache tokens |
| `cache_creation.ephemeral_1h_input_tokens` | number | Longer-lived cache tokens |
| `output_tokens` | number | Output tokens generated |
| `service_tier` | string | `"standard"` observed |
| `inference_geo` | string | `"not_available"` or `""` |
| `server_tool_use` | object | Server-side tool use counts (optional) |
| `iterations` | array | Empty array observed |
| `speed` | string | `"standard"` observed |

Note: `server_tool_use`, `iterations`, and `speed` only appear on the final chunk (where `stop_reason` is set).

---

## Type: `system`

System messages record metadata about assistant turns.

```json
{
  "parentUuid": "c43c07a2-a5e3-4081-b228-234cd75b7915",
  "isSidechain": false,
  "type": "system",
  "subtype": "turn_duration",
  "durationMs": 39003,
  "messageCount": 15,
  "timestamp": "2026-03-30T21:15:40.821Z",
  "uuid": "77e3c02f-4547-476b-8c85-8371073b0f0c",
  "isMeta": false,
  "userType": "external",
  "entrypoint": "cli",
  "cwd": "/home/kitty/Desktop/self-views",
  "sessionId": "20fe2962-5517-46d9-984d-f04ec870f65c",
  "version": "2.1.87",
  "gitBranch": "HEAD",
  "slug": "serene-tumbling-salamander"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"system"` | Message type discriminator |
| `subtype` | string | `"turn_duration"` observed |
| `durationMs` | number | Wall-clock time for the assistant turn in milliseconds |
| `messageCount` | number | Total messages in the session so far at this point |
| `isMeta` | boolean | `false` observed |
| `parentUuid` | string (UUID) | Last message UUID before this system message |

---

## Type: `progress`

Progress messages track async operations. The `data.type` field discriminates subtypes.

### Common Fields

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"progress"` | Message type discriminator |
| `data` | object | Progress-specific payload (see subtypes below) |
| `toolUseID` | string | ID of the tool operation being tracked |
| `parentToolUseID` | string | Parent tool operation ID |
| `parentUuid` | string (UUID) \| null | Previous message UUID |

### Subtype: `hook_progress`

Tracks execution of configured hooks (e.g., session start hooks).

```json
{
  "type": "progress",
  "data": {
    "type": "hook_progress",
    "hookEvent": "SessionStart",
    "hookName": "SessionStart:startup",
    "command": "\"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd\" session-start"
  },
  "parentToolUseID": "b2dd6433-e5fa-4bf6-a48f-08093e134a22",
  "toolUseID": "b2dd6433-e5fa-4bf6-a48f-08093e134a22",
  "timestamp": "2026-03-19T18:51:53.222Z",
  "uuid": "2a7bdf07-ba1a-4257-a9cf-ea9fe1a0a8b5"
}
```

### Subtype: `agent_progress`

Tracks subagent (Task tool) execution. Contains the full subagent message being processed.

```json
{
  "type": "progress",
  "data": {
    "type": "agent_progress",
    "message": {
      "type": "user",
      "message": {
        "role": "user",
        "content": [{ "type": "text", "text": "Research tscircuit..." }]
      }
    }
  },
  "toolUseID": "...",
  "parentToolUseID": "..."
}
```

### Subtype: `query_update`

Tracks web search queries being executed.

```json
{
  "type": "progress",
  "data": {
    "type": "query_update",
    "query": "tscircuit KiCad export schematic .kicad_sch"
  },
  "toolUseID": "search-progress-1",
  "parentToolUseID": "toolu_01S8wTzZd9mFr1X7eR5bL7Fd"
}
```

### Subtype: `search_results_received`

Records that web search results were received.

```json
{
  "type": "progress",
  "data": {
    "type": "search_results_received",
    "resultCount": 10,
    "query": "tscircuit KiCad export schematic .kicad_sch"
  },
  "toolUseID": "srvtoolu_01H7ppqNzNYJwR8GDj7reArz",
  "parentToolUseID": "toolu_01S8wTzZd9mFr1X7eR5bL7Fd"
}
```

---

## Type: `file-history-snapshot`

Checkpoints for file undo/restore. Created before each user turn and updated when files are modified.

### Initial Snapshot (empty)

```json
{
  "type": "file-history-snapshot",
  "messageId": "6899fa30-f4d8-4e2e-beac-8eae8768d640",
  "snapshot": {
    "messageId": "6899fa30-f4d8-4e2e-beac-8eae8768d640",
    "trackedFileBackups": {},
    "timestamp": "2026-03-27T00:51:21.799Z"
  },
  "isSnapshotUpdate": false
}
```

### Updated Snapshot (with tracked files)

```json
{
  "type": "file-history-snapshot",
  "messageId": "f4b09eed-6382-44a5-b331-8e1d7cec4113",
  "snapshot": {
    "messageId": "1a931991-4542-4729-8742-c3092962f7f2",
    "trackedFileBackups": {
      "/home/kitty/.claude/projects/-home-kitty-Desktop-self-views/memory/user_professional.md": {
        "backupFileName": null,
        "version": 1,
        "backupTime": "2026-03-30T21:15:21.893Z"
      },
      "CLAUDE.md": {
        "backupFileName": "83ab69055d16ae2c@v1",
        "version": 1,
        "backupTime": "2026-03-19T19:15:59.003Z"
      }
    },
    "timestamp": "2026-03-30T21:15:01.789Z"
  },
  "isSnapshotUpdate": true
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"file-history-snapshot"` | Message type discriminator |
| `messageId` | string (UUID) | Links to the user message this snapshot precedes |
| `isSnapshotUpdate` | boolean | `false` for initial; `true` for updates after file modifications |
| `snapshot.messageId` | string (UUID) | May differ from outer `messageId` on updates |
| `snapshot.trackedFileBackups` | object | Map of file path to backup info |
| `snapshot.timestamp` | string (ISO 8601) | When the snapshot was taken |

### File Backup Entry

| Field | Type | Description |
|-------|------|-------------|
| `backupFileName` | string \| null | Filename in `file-history/{session-id}/` (e.g., `"83ab69055d16ae2c@v1"`). `null` if file was newly created. |
| `version` | number | Backup version counter |
| `backupTime` | string (ISO 8601) | When backup was created |

The backup files are stored at `~/.claude/file-history/{session-id}/{hash}@v{N}` where `{hash}` is a hex string derived from the file path and `{N}` is the version number.

---

## Type: `queue-operation`

Records user message queue operations. These occur when the user types messages while the assistant is still processing.

```json
{
  "type": "queue-operation",
  "operation": "enqueue",
  "timestamp": "2026-03-30T21:16:22.164Z",
  "sessionId": "20fe2962-5517-46d9-984d-f04ec870f65c",
  "content": "added to claude.md"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"queue-operation"` | Message type discriminator |
| `operation` | string | `"enqueue"`, `"dequeue"`, or `"remove"` |
| `timestamp` | string (ISO 8601) | When the operation occurred |
| `sessionId` | string (UUID) | Session this belongs to |
| `content` | string | Only present on `"enqueue"`. The queued user message text. |

Note: `queue-operation` messages do NOT have `uuid`, `parentUuid`, or the common envelope fields that other types have.

---

## Conversation Chain: parentUuid Linked List

Messages form a singly-linked list via `parentUuid`:

```
user (parentUuid=null, uuid=A)
  -> assistant/thinking (parentUuid=A, uuid=B)
    -> assistant/tool_use (parentUuid=B, uuid=C)
      -> user/tool_result (parentUuid=C, uuid=D)
        -> assistant/thinking (parentUuid=D, uuid=E)
          -> assistant/text (parentUuid=E, uuid=F)
            -> system/turn_duration (parentUuid=F, uuid=G)
```

The first user message in a session has `parentUuid: null` (or points to a progress message if hooks ran first).

### promptId Grouping

The `promptId` field on `user` messages groups an entire interaction turn. A single `promptId` covers:
1. The initial user text message
2. All tool result messages in that turn
3. (The assistant messages between them reference the same turn implicitly via the chain)

A new `promptId` is generated each time the user sends a new prompt.

---

## Sidechain and Subagents

### isSidechain Field

The `isSidechain` field is `false` for main conversation messages and `true` for subagent (Task tool) messages.

In the main session JSONL, all messages have `isSidechain: false`. Subagent conversations are stored in separate files:

```
{session-id}/subagents/agent-{agent-id}.jsonl
{session-id}/subagents/agent-{agent-id}.meta.json
```

### Subagent Meta

```json
{
  "agentType": "general-purpose",
  "description": "Research tscircuit for schematics"
}
```

### Subagent JSONL

Subagent JSONL files use the same format as main session files but with:
- `isSidechain: true` on all messages
- `agentId: "a175b86a4f0803fd8"` field on all messages
- Same `sessionId` as the parent session
- The first message contains the full task prompt

```json
{
  "parentUuid": null,
  "isSidechain": true,
  "promptId": "e0451dad-24a8-447c-b052-41a09b124388",
  "agentId": "a175b86a4f0803fd8",
  "type": "user",
  "message": {
    "role": "user",
    "content": "Research tscircuit (https://tscircuit.com)..."
  },
  "uuid": "f7db0c42-6cb2-4753-8fec-1c7f04f6dd49",
  "timestamp": "2026-03-19T19:01:53.265Z",
  "sessionId": "3d8de6c2-d484-460d-ac66-ae4776fce1d9",
  "..."
}
```

The agent ID is a hex string like `"a175b86a4f0803fd8"` (not a UUID).

---

## Session Slug

Each session gets a human-readable slug like `"precious-frolicking-stearns"` or `"serene-tumbling-salamander"`. The slug follows the pattern: `{adjective}-{verb/adjective}-{surname}`. It appears on messages after the first assistant response (not on the initial user message or file-history-snapshot).

---

## Global History: `history.jsonl`

The root `~/.claude/history.jsonl` is a log of user inputs across all sessions:

```json
{
  "display": "/cost",
  "pastedContents": {},
  "timestamp": 1759550033201,
  "project": "/home/kitty/Desktop/network/node"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `display` | string | The user's input text (may be a slash command) |
| `pastedContents` | object | Pasted content (usually empty `{}`) |
| `timestamp` | number | Unix timestamp in milliseconds |
| `project` | string | Project path |

---

## Memory Files

Each project can have a `memory/` directory containing markdown files that persist across sessions:

```
projects/{project-slug}/memory/
  MEMORY.md
  user_profile.md
  project_status.md
  feedback_dev_preferences.md
  inventory.md
  user_professional.md
```

These are managed by Claude Code's memory system and loaded into context at session start.

---

## Summary of Key Relationships

```
sessions/{pid}.json  ──sessionId──>  projects/{slug}/{sessionId}.jsonl
                                          │
                                          ├── JSONL lines linked by parentUuid chain
                                          ├── user messages grouped by promptId
                                          ├── assistant chunks grouped by requestId + message.id
                                          │
                                          └── {sessionId}/subagents/
                                                  ├── agent-{id}.jsonl  (isSidechain=true)
                                                  └── agent-{id}.meta.json

sessions-index.json  ──sessionId──>  projects/{slug}/{sessionId}.jsonl
file-history/{sessionId}/            File backups referenced by file-history-snapshot messages
tasks/{sessionId}/                   Task agent data
```

---

## Reconstructing a Conversation

To reconstruct a readable conversation from a session JSONL:

1. Read all lines from the JSONL file
2. Filter to `type === "user"` and `type === "assistant"` (ignore progress, system, queue-operation, file-history-snapshot)
3. For user messages: if `message.content` is a string, it is user text. If it is an array of `tool_result`, it is a tool response.
4. For assistant messages: group consecutive lines with the same `requestId` to reconstruct the full response. Concatenate content blocks in order (thinking -> text -> tool_use).
5. Follow the `parentUuid` chain to establish ordering (or simply use chronological order via timestamps -- they are equivalent for non-branching conversations).
6. Use `stop_reason` to determine turn boundaries: `"end_turn"` means the assistant finished speaking, `"tool_use"` means it is waiting for a tool result.
