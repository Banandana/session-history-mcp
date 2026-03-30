# Tool Results and File History in Claude Code

Research into how Claude Code persists tool outputs and tracks file changes on disk.

## 1. Tool Results: `~/.claude/projects/{project-slug}/{session-id}/tool-results/`

### Overview

When a tool call produces output that exceeds a size threshold, Claude Code persists the full output to a file on disk and replaces the in-context content with a truncated preview wrapped in `<persisted-output>` tags.

### File Naming Schemes

There are four distinct naming patterns for tool-result files:

#### 1a. Short Base36 IDs (e.g., `b3k2xtc90.txt`)

- All observed IDs start with `b` and are 9 alphanumeric characters long
- Appear to be randomly generated (no sequential pattern observed)
- Used for **Bash tool outputs** and other built-in tool results that exceed the size threshold
- The ID does NOT correspond to the `tool_use_id` from the API

#### 1b. `toolu_` IDs (e.g., `toolu_017RW146MZuDg24NUPFggKUm.txt`)

- Uses the actual Anthropic `tool_use_id` as the filename
- Observed specifically for **subagent tool results** (tool calls made by Task/Agent subagents)
- The `toolu_` ID directly maps to the `tool_use` block in the JSONL conversation log
- Example: `toolu_017RW146MZuDg24NUPFggKUm` in JSONL matches `toolu_017RW146MZuDg24NUPFggKUm.txt` on disk

#### 1c. MCP Tool Results (e.g., `mcp-mouser-search_by_keyword-1774753454662.txt`)

- Format: `mcp-{server-name}-{tool-name}-{unix-timestamp-ms}.txt`
- The timestamp is millisecond-precision Unix epoch time
- Used when MCP server tool calls produce large results
- Example: `mcp-kicad-get_board_2d_view-1774422833824.txt` = kicad server, get_board_2d_view tool, called at timestamp 1774422833824

#### 1d. WebFetch Results (e.g., `webfetch-1774753448077-2sw7wj.pdf`)

- Format: `webfetch-{unix-timestamp-ms}-{random-6-char}.pdf`
- These are actual PDF files (not text), stored when WebFetch downloads a PDF document
- Verified as real PDF documents with `file` command

#### 1e. PDF Page Renders (e.g., `pdf-03219a28-411d-4e4b-8f4c-1636f0775c0d/`)

- These are **directories**, not files
- Format: `pdf-{uuid}/`
- Contain JPEG page renders: `page-11.jpg`, `page-12.jpg`, etc.
- Created when the Read tool processes PDF files, rendering specific pages to images
- Images are standard JPEG, 827x1170 pixels at 100 DPI

### Content Format of .txt Files

Tool-result `.txt` files contain the **raw tool output** with no wrapper or metadata:

- **Bash tool results**: Raw stdout content (directory listings, command output, etc.)
- **Grep/Read results**: Raw file content with line numbers (cat -n format) or grep match output
- **MCP tool results**: Raw JSON response from the MCP server (e.g., Mouser search results as JSON)

There is no header, metadata envelope, or timestamp in the file itself. The file is purely the tool's output text.

### How Tool Results Appear in Session JSONL

When output is too large, the `tool_result` content in the JSONL is replaced with a `<persisted-output>` tag:

```json
{
  "tool_use_id": "toolu_013UL52fuh3Dxbaf5qGBiG7e",
  "type": "tool_result",
  "content": "<persisted-output>\nOutput too large (128.6KB). Full output saved to: /home/kitty/.claude/projects/-home-kitty-Desktop-ginny-board/288d5ff8-b52d-4238-8a08-0ac39920b7b9/tool-results/b2u11i3ol.txt\n\nPreview (first 2KB):\n/home/kitty/.claude/.credentials.json\n/home/kitty/.claude/history.jsonl\n...\n</persisted-output>",
  "is_error": false
}
```

The `<persisted-output>` block contains:
1. A size notice: `Output too large ({size}KB).`
2. The absolute path to the saved file: `Full output saved to: {path}`
3. A truncated preview: `Preview (first 2KB):\n{preview-text}\n...`

### Relationship Between Tool-Result Files and JSONL

- The tool-result file path appears **inside** the `tool_result.content` field as a `<persisted-output>` tag
- For **subagent** tool results, the reference appears in `type: "progress"` JSONL entries (inside `data.message.message.content[]`)
- For **main session** tool results, the reference appears in `type: "user"` JSONL entries (inside `message.content[]`)
- The base36 short IDs (`b*`) do NOT appear anywhere in the JSONL except within the `<persisted-output>` content string
- The `toolu_*` IDs appear both as the filename AND as the `tool_use_id` / `tool_use.id` in the JSONL

### Normal (Non-Persisted) Tool Results in JSONL

When tool output is small enough to fit in context, it appears inline in the JSONL with both the message content and a `toolUseResult` field:

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      {
        "tool_use_id": "toolu_01KT4JaWs45DS35KhJzqiPiX",
        "type": "tool_result",
        "content": "board-placed\nbom.csv\nbom.json\n...",
        "is_error": false
      }
    ]
  },
  "toolUseResult": {
    "stdout": "board-placed\nbom.csv\nbom.json\n...",
    "stderr": "",
    "interrupted": false,
    "isImage": false,
    "noOutputExpected": false
  }
}
```

The `toolUseResult` field is present on all tool_result user messages and contains structured metadata about the execution. For Bash tools it has `stdout`/`stderr`/`interrupted`/`isImage`/`noOutputExpected`. For Write/Edit tools it contains the operation details (see below).

## 2. Read/Write/Edit Tool Calls in Session JSONL

### Write Tool

**Tool call** (in assistant message):
```json
{
  "type": "tool_use",
  "id": "toolu_01UVvDLH3tWvMJPXPtbDR5sk",
  "name": "Write",
  "input": {
    "file_path": "/home/kitty/KiCAD-MCP-Server/CLAUDE.md",
    "content": "# KiCAD MCP Server\n\n## What This Project Is\n..."
  }
}
```

**Tool result** (in user message):
```json
{
  "tool_use_id": "toolu_01UVvDLH3tWvMJPXPtbDR5sk",
  "type": "tool_result",
  "content": "File created successfully at: /home/kitty/KiCAD-MCP-Server/CLAUDE.md",
  "is_error": false
}
```

With `toolUseResult`:
```json
{
  "type": "create",
  "filePath": "/home/kitty/KiCAD-MCP-Server/CLAUDE.md",
  "content": "# KiCAD MCP Server\n\n## What This Project Is\n..."
}
```

The `toolUseResult` for Write contains:
- `type`: `"create"` (new file) or `"update"` (overwrite)
- `filePath`: Absolute path
- `content`: The full file content that was written

### Edit Tool

**Tool call** (in assistant message):
```json
{
  "type": "tool_use",
  "id": "toolu_013u3z9LrCktZpy3Wsa6u4E2",
  "name": "Edit",
  "input": {
    "file_path": "/home/kitty/KiCAD-MCP-Server/python/kicad_interface.py",
    "old_string": "\"import_svg_logo\": self._handle_import_svg_logo,",
    "new_string": "\"import_svg_logo\": self._handle_import_svg_logo,\n            # New batch/power tools\n            \"add_power_symbol\": self._handle_add_power_symbol,\n            \"batch_c..."
  }
}
```

**Tool result** (in user message):
```json
{
  "tool_use_id": "toolu_013u3z9LrCktZpy3Wsa6u4E2",
  "type": "tool_result",
  "content": "The file /home/kitty/KiCAD-MCP-Server/python/kicad_interface.py has been updated successfully.",
  "is_error": false
}
```

With `toolUseResult`:
```json
{
  "filePath": "/home/kitty/KiCAD-MCP-Server/python/kicad_interface.py",
  "oldString": "\"export_schematic_svg\": self._handle_export_schematic_svg,\n            \"import_svg_logo\": self._handle_import_svg_logo,",
  "newString": "\"export_schematic_svg\": self._handle_export_schematic_svg,\n            \"import_svg_logo\": self._handle_import_svg_logo,\n            # New batch/power tools\n            \"add_power_symbol\": self._handle_add_power_symbol,\n            \"batch_c..."
}
```

The `toolUseResult` for Edit contains:
- `filePath`: Absolute path
- `oldString`: The text that was replaced
- `newString`: The replacement text

### Read Tool

**Tool result** (in user message) -- when file is too large:
```json
{
  "tool_use_id": "toolu_01MsVxy4HWEdDZXN6mheEELT",
  "type": "tool_result",
  "content": "File content (96906 tokens) exceeds maximum allowed tokens (10000)...",
  "is_error": false
}
```

With `toolUseResult` as a string (not object):
```
"Error: File content (96906 tokens) exceeds maximum allowed tokens (10000)..."
```

For successful reads, the file content appears directly in `tool_result.content`. The `toolUseResult` for Read is typically a string rather than an object.

## 3. File History: `~/.claude/file-history/`

### Directory Structure

```
~/.claude/file-history/
  {session-id}/
    {file-hash}@v{version}
    {file-hash}@v{version}
    ...
```

- Each session that modifies files gets a directory named by session UUID
- Files within are named `{hash}@v{version}` where:
  - `hash` = first 16 hex characters of `SHA-256(absolute-file-path)`
  - `version` = incrementing integer starting at 1

### Hash Algorithm (Verified)

The file hash is the **first 16 hex characters of SHA-256** of the absolute file path (as a UTF-8 string):

```
SHA-256("/home/kitty/Desktop/chai-board/CLAUDE.md")[:16] = "b5e3c368815fe8ab"
SHA-256("/home/kitty/KiCAD-MCP-Server/python/kicad_interface.py")[:16] = "28c7b9832af40e88"
SHA-256("/home/kitty/KiCAD-MCP-Server/src/server.ts")[:16] = "098ac445185d788a"
SHA-256("/home/kitty/KiCAD-MCP-Server/CLAUDE.md")[:16] = "3bcaa6a001164b34"
```

### Backup File Content

Backup files contain the **exact file content at the time of backup** -- raw source code, markdown, etc. with no metadata wrapper. They are literal copies of the file as it existed before or after modification.

File permissions vary: some are `rw-------` (600), others `rw-r--r--` (644). Some backup files have a hard link count of 2, suggesting Claude Code uses hard links to deduplicate identical versions.

### Version Semantics

- `v1` = the file content **before** the first modification in this session (the original state)
- `v2`, `v3`, ... = the file content before each subsequent modification
- A `null` `backupFileName` at version 1 means the file was **newly created** in this session (no prior content to back up)
- Versions increment each time the file is modified by Write or Edit tools

### Scale Observations

- The largest session observed had 104 backup files (KiCAD MCP Server session)
- A single file (kicad_interface.py) accumulated 25 versions in one session
- Total across all sessions: 624 backup files

## 4. File-History-Snapshot Entries in Session JSONL

### Structure

```json
{
  "type": "file-history-snapshot",
  "messageId": "e1194168-f0fa-401d-8656-06ba2c90177f",
  "snapshot": {
    "messageId": "aad10cc8-f620-46f0-9682-c9e59a21e9d9",
    "trackedFileBackups": {
      "CLAUDE.md": {
        "backupFileName": "b5e3c368815fe8ab@v2",
        "version": 2,
        "backupTime": "2026-03-29T02:27:39.183Z"
      },
      "python/kicad_interface.py": {
        "backupFileName": "28c7b9832af40e88@v1",
        "version": 1,
        "backupTime": "2026-03-20T01:30:27.181Z"
      }
    },
    "timestamp": "2026-03-29T02:27:39.183Z"
  },
  "isSnapshotUpdate": false
}
```

### Field Definitions

| Field | Description |
|-------|-------------|
| `type` | Always `"file-history-snapshot"` |
| `messageId` | UUID of the JSONL entry itself (the snapshot record) |
| `snapshot.messageId` | UUID of the **user message** (conversation turn) that this snapshot is associated with. For `isSnapshotUpdate: true`, this points to the original snapshot's message, NOT the current entry. |
| `snapshot.trackedFileBackups` | Map of **relative file paths** (relative to project root) to backup info |
| `snapshot.trackedFileBackups[file].backupFileName` | Filename in `~/.claude/file-history/{session-id}/`, or `null` if file was newly created |
| `snapshot.trackedFileBackups[file].version` | Version number (incrementing per file per session) |
| `snapshot.trackedFileBackups[file].backupTime` | ISO 8601 timestamp of when the backup was taken |
| `snapshot.timestamp` | ISO 8601 timestamp of the snapshot itself |
| `isSnapshotUpdate` | `false` = initial snapshot for a conversation turn; `true` = update to an existing snapshot (additional files modified in the same turn) |

### Snapshot Lifecycle

1. When a conversation turn begins that will modify files, an **initial snapshot** is created with `isSnapshotUpdate: false` and empty `trackedFileBackups: {}`
2. As files are modified (Write/Edit), **update snapshots** are appended with `isSnapshotUpdate: true`, accumulating all tracked files
3. The `snapshot.messageId` remains constant across all updates within a single conversation turn, pointing to the original user message UUID
4. The outer `messageId` changes for each snapshot entry

### Relationship to Conversation Messages

- `snapshot.messageId` maps to the `uuid` of a `type: "user"` entry in the JSONL
- This is the human's message (or tool_result return) that triggered the assistant's response containing Write/Edit calls
- Multiple snapshot entries can share the same `snapshot.messageId` when a single turn modifies multiple files progressively

### Observed Patterns

- Sessions typically have one snapshot per conversation turn that modifies files
- A session with heavy file editing had 87 snapshot entries
- When a turn modifies N files, there is typically 1 initial + N update entries (though some modifications batch)
- Files tracked use **relative paths** from the project root (e.g., `python/kicad_interface.py`, `CLAUDE.md`)

## 5. Cross-Reference Summary

### How to Reconstruct File Changes from JSONL + File History

1. Parse JSONL for `type: "file-history-snapshot"` entries
2. For each snapshot with `isSnapshotUpdate: true`, the `trackedFileBackups` map shows:
   - Which files were modified (relative paths)
   - What version they were backed up as
   - The backup filename to find in `~/.claude/file-history/{session-id}/`
3. Cross-reference `snapshot.messageId` with JSONL to find the conversation context
4. Find the corresponding Edit/Write `tool_use` and `tool_result` entries near that message to see exactly what changed
5. The actual backup file in `~/.claude/file-history/` contains the file content **before** the modification at that version

### How to Reconstruct Tool Outputs from JSONL + Tool Results

1. Parse JSONL for `tool_result` entries in user messages
2. If `content` contains `<persisted-output>`, extract the file path from the tag
3. The filename in the path determines the type:
   - `b{9chars}.txt` = built-in tool (Bash, Grep, etc.) output
   - `toolu_{id}.txt` = subagent tool output (ID matches `tool_use.id` in JSONL)
   - `mcp-{server}-{tool}-{timestamp}.txt` = MCP server tool output
   - `pdf-{uuid}/` = PDF page renders (directory of JPEGs)
   - `webfetch-{timestamp}-{random}.pdf` = downloaded PDF files
4. Read the file for full output; the JSONL `<persisted-output>` tag contains only a 2KB preview
