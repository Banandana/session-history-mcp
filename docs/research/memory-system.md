# Claude Code Memory System - Research Documentation

Research conducted 2026-03-30 by analyzing `~/.claude/` on a live system with 20+ projects.

## Overview

Claude Code stores persistent memory as markdown files with YAML frontmatter, organized per-project under `~/.claude/projects/`. There is no global-level memory directory -- all memories are project-scoped. Memory is surfaced to the model via system-reminder context injection at session start.

## Directory Structure

```
~/.claude/
  projects/
    {project-slug}/              # e.g. -home-kitty-Desktop-ginny-decoder
      memory/
        MEMORY.md                # Index file listing all memories for this project
        feedback_dev_preferences.md
        project_status.md
        user_profile.md
        reference_ginny_schematic_rules.md
        ...
      {session-uuid}.jsonl       # Session transcript logs
      {session-uuid}/            # Session working directories (subagents, tool-results)
      sessions-index.json        # Optional session index (not always present)
```

### Project Slug Format

Directory names are the absolute project path with `/` replaced by `-`:

| Project Path | Slug |
|---|---|
| `/home/kitty/Desktop/ginny-decoder` | `-home-kitty-Desktop-ginny-decoder` |
| `/home/kitty/KiCAD-MCP-Server` | `-home-kitty-KiCAD-MCP-Server` |
| `/home/kitty` | `-home-kitty` |

Note: A bare `-` directory also exists (likely from a root `/` or empty path edge case).

## MEMORY.md Index File

Each project's `memory/MEMORY.md` serves as the index. Two distinct formats have been observed:

### Format 1: Bullet List (most common)

A flat markdown bullet list where each entry links to a memory file with a brief description after `---`:

```markdown
- [user_profile.md](user_profile.md) --- User has FreeRTOS/STM32F411 experience, preferred MCU for v1
- [inventory.md](inventory.md) --- Parts on hand: MCUs, driver ICs, op-amps, logic ICs, passives, display, MAX9926
- [feedback_dev_preferences.md](feedback_dev_preferences.md) --- Avoid HAL (use LL/registers), no x86 testing, CubeMX is fine, hardware is primary focus
- [project_status.md](project_status.md) --- Hardware v1 sent to fab 2026-03-18, firmware not started, next steps
```

Some indices include a `# Memory Index` heading; others omit it.

### Format 1b: Sectioned Bullet List

Some projects group entries under headings by type:

```markdown
# Memory Index

## Project
- [Wire connectivity bugs](project_wire_connectivity_bugs.md) --- Validated T-junction tracing, junction corruption, and ERC bugs from real usage
- [kicad-skip parsing failures](project_kicad_skip_failures.md) --- kicad-skip fails on some KiCad 9 files; ~24 handlers still vulnerable
```

### Format 2: Freeform Prose (rare)

One project (hondata-stuff) used a completely different structure -- a full prose document with sections like `## Project Overview`, `## File Index`, `## Key Technical Facts`, `## User Preferences`. This appears to be an older or manually-curated format that predates the structured memory system.

### Index Entry Pattern

Each bullet entry follows this structure:
```
- [{display-name}]({filename}.md) --- {one-line description}
```

The display name can be:
- The filename itself: `[user_profile.md](user_profile.md)`
- A human-readable name: `[Wire connectivity bugs](project_wire_connectivity_bugs.md)`
- A descriptive phrase: `[Never create custom KiCad symbols/footprints](feedback_no_custom_symbols.md)`

The em-dash separator (`---`) consistently separates the link from the description.

## Individual Memory File Format

Every memory file is a Markdown file with YAML frontmatter containing three required fields.

### Structure

```markdown
---
name: {human-readable name}
description: {one-line summary of what this memory captures}
type: {user|feedback|project|reference}
---

{body content in markdown}
```

### Frontmatter Fields

| Field | Required | Description |
|---|---|---|
| `name` | Yes | Human-readable title. Can be a phrase, sentence, or identifier. |
| `description` | Yes | One-line summary. Often mirrors or expands the MEMORY.md index description. |
| `type` | Yes | Category enum: `user`, `feedback`, `project`, or `reference`. |

No other frontmatter fields have been observed (no timestamps, no IDs, no tags, no cross-references in frontmatter).

### Memory Types

#### `user` - User profile information

Captures persistent facts about the user that should inform future interactions. Not project-specific knowledge, but user preferences, background, and capabilities.

**Filename pattern:** `user_{topic}.md`

**Examples observed:**
- `user_profile.md` -- MCU experience, preferred hardware, project context
- `user_professional.md` -- Professional background, analytical style, age bracket
- `user_interview_framework.md` -- User's established analytical positions on interviews

**Body style:** Bullet lists or short paragraphs. Factual, third-person ("User has...", "Cross-domain engineer...").

**Example:**
```markdown
---
name: user_profile
description: User has FreeRTOS experience with STM32F411, prefers F411 for v1, has STM32 flashing hardware
type: user
---

- Has existing FreeRTOS code for STM32F411, making it the preferred MCU for v1 of Ginny
- Prefers STM32F411CEU6 (Black Pill) over STM32H723ZGT6 for first version
- Has STM32 flashing/debugging hardware on hand
- Working on Honda H22 ignition decoder board (codename Ginny)
```

#### `feedback` - Corrections and behavioral directives

Captures explicit user corrections, preferences, and "never do X" rules. These are lessons learned from mistakes or misunderstandings. Almost always includes **Why** and **How to apply** sections.

**Filename pattern:** `feedback_{topic}.md`

**Examples observed:**
- `feedback_no_training_data_for_parts.md` -- Never trust training data for IC specs
- `feedback_stop_on_mcp_failure.md` -- Stop immediately when MCP tools fail
- `feedback_dev_preferences.md` -- LL over HAL, no x86 testing
- `feedback_kicad_mcp.md` -- Hard-won lessons about KiCad MCP usage
- `feedback_label_wiring.md` -- Critical wiring rule for schematic labels
- `feedback_document_roles.md` -- Role separation: user provides content, LLM manages structure

**Body style:** Directive/imperative tone. Structured with bold **Why:** and **How to apply:** subsections. Often opens with a clear rule statement.

**Example:**
```markdown
---
name: Stop immediately on MCP failures
description: Never work around MCP tool failures -- stop and report the problem so the user can fix the MCP server
type: feedback
---

When an MCP tool fails or returns unexpected results, STOP IMMEDIATELY and tell the user what broke. Do not attempt workarounds like reading files directly, parsing s-expressions, or using alternative approaches.

**Why:** The user maintains the MCP servers and can fix them. Workarounds waste time, produce unreliable results, and hide problems that need fixing.

**How to apply:** If any MCP tool call fails, errors, or returns data that doesn't make sense -- stop all work on that task, report exactly which tool failed, what the error was, and what you were trying to do. Wait for the user to fix it before continuing.
```

#### `project` - Project-specific knowledge and status

Captures technical decisions, current status, known bugs, architectural choices, and domain knowledge specific to the project.

**Filename pattern:** `project_{topic}.md`

**Examples observed:**
- `project_status.md` -- Current project status, what's been done, next steps
- `project_cranking_strategy.md` -- Technical decision about cranking behavior
- `project_wire_connectivity_bugs.md` -- Validated bugs with reproduction details
- `project_ai_cognitive_decline.md` -- Established analytical positions for a research project
- `project_kicad10_paths.md` -- Environment-specific configuration facts
- `project_purpose.md` -- High-level project description and rules

**Body style:** Varies widely. Can be bullet lists, numbered lists, or prose. Often includes **Why:** and **How to apply:** sections. Technical content can be quite detailed.

**Example:**
```markdown
---
name: cranking_pass_through_strategy
description: During cranking, pass through ECU IGN signal directly to all coils (wasted-spark) until VR sync acquired
type: project
---

During cranking, pass through the ECU IGN signal directly to all coils (wasted-spark style). Once CKP/CYP edges are reliably detected (RPM > ~400, edge spacing < 85ms MAX9926 watchdog), firmware switches to sequential COP mode.

**Why:** MAX9926 adaptive threshold has 85ms watchdog that may cause missed edges at cranking RPM (50-150 RPM).

**How to apply:** Firmware state machine -- no hardware changes needed. Implementation priority is after basic COP sequencing works.
```

#### `reference` - Reusable technical reference material

Captures reference data that may be useful across sessions or even across projects. Things like rules, inventory lists, specifications.

**Filename pattern:** `reference_{topic}.md` or descriptive names like `inventory.md`

**Examples observed:**
- `reference_ginny_schematic_rules.md` -- Detailed KiCad schematic layout rules (cross-project reference)
- `inventory.md` -- Physical parts inventory

**Body style:** Structured reference content. Lists, tables, or rule sets. May reference external files.

**Example:**
```markdown
---
name: inventory
description: Parts and hardware the user has on hand -- check before recommending purchases
type: reference
---

## MCU / Dev Boards
- 1x STM32F411CEU6 (Black Pill form factor)
- 1x STM32H723ZGT6

## Power / Driver ICs
- 6x Infineon BTG70013A-1ESW (PROFET Wire Guard 12V, smart high-side switch)
...
```

## File Naming Conventions

Memory filenames follow a `{type}_{topic}.md` pattern, though not strictly enforced:

| Pattern | Examples |
|---|---|
| `feedback_{topic}.md` | `feedback_no_custom_symbols.md`, `feedback_stop_on_mcp_failure.md` |
| `project_{topic}.md` | `project_status.md`, `project_cranking_strategy.md` |
| `user_{topic}.md` | `user_profile.md`, `user_professional.md` |
| `reference_{topic}.md` | `reference_ginny_schematic_rules.md` |
| `{plain_name}.md` | `inventory.md` (type=reference) |

The filename prefix usually matches the `type` frontmatter field, but exceptions exist (e.g., `inventory.md` with `type: reference`).

## Body Content Patterns

### The Why/How Pattern

Most memory files (especially `feedback` and `project` types) follow a consistent body structure:

1. **Opening statement** -- The core fact, rule, or decision in plain language
2. **Why:** -- Context explaining the reason (often a specific incident or technical rationale)
3. **How to apply:** -- Concrete instructions for how to use this memory in future sessions

This pattern is not enforced by any schema but is consistently followed across projects.

### Content Tone by Type

| Type | Tone | Voice |
|---|---|---|
| `user` | Factual, descriptive | Third person ("User has...", "Cross-domain engineer...") |
| `feedback` | Directive, imperative | Second person ("NEVER use...", "STOP IMMEDIATELY...") |
| `project` | Technical, descriptive | Mixed (facts + directives) |
| `reference` | Neutral, structured | Reference documentation style |

## Cross-Referencing

There is no formal cross-reference system in the memory files themselves. However:

1. **Reference memories can span projects** -- `reference_ginny_schematic_rules.md` in the chai-board project explicitly references content from the ginny-board project's CLAUDE.md
2. **Index descriptions serve as summaries** -- The MEMORY.md descriptions are concise enough to help the model decide which memories to load
3. **No IDs, tags, or linking metadata** -- Memories are standalone documents with no formal relationship graph

## Relationship to CLAUDE.md

- `~/.claude/CLAUDE.md` -- Global instructions file, manually authored. Not part of the memory system.
- `{project-root}/CLAUDE.md` -- Project-level instructions, also manually authored. Not part of the memory system.
- Memory files are separate from CLAUDE.md and stored exclusively under `~/.claude/projects/{slug}/memory/`.

The memory system is complementary to CLAUDE.md: CLAUDE.md contains static instructions/configuration, while memory files capture dynamic learned knowledge from conversations.

## Scope: Global vs Project

**All observed memories are project-scoped.** No global memory directory (`~/.claude/memory/`) exists. Each project gets its own isolated memory directory.

This means:
- User profile memories (type=user) are duplicated per project if needed
- There is no automatic sharing of memories between projects
- Cross-project knowledge transfer happens via `reference` type memories that explicitly cite other projects

## Projects Without Memory

Not all projects have memory directories. Of 22 project slugs observed, only 10 had `memory/` directories. Projects without memory include some with sessions (mayhem-firmware, mcp-meta-mcp, etc.), suggesting memory creation is opt-in or triggered by specific interactions.

## Summary: Data Model for MCP Server

A memory entry can be represented as:

```typescript
interface Memory {
  // From frontmatter
  name: string;           // Human-readable title
  description: string;    // One-line summary
  type: 'user' | 'feedback' | 'project' | 'reference';

  // Derived from filesystem
  filename: string;       // e.g. "feedback_stop_on_mcp_failure.md"
  projectSlug: string;    // e.g. "-home-kitty-Desktop-ginny-decoder"
  projectPath: string;    // e.g. "/home/kitty/Desktop/ginny-decoder"

  // Body content
  content: string;        // Full markdown body (after frontmatter)
}

interface MemoryIndex {
  projectSlug: string;
  entries: {
    displayName: string;  // Link text in MEMORY.md
    filename: string;     // Target filename
    description: string;  // Text after em-dash separator
  }[];
}
```

### Key filesystem paths:
- **Index:** `~/.claude/projects/{slug}/memory/MEMORY.md`
- **Memory file:** `~/.claude/projects/{slug}/memory/{filename}.md`
- **Project slug derivation:** absolute path with `/` replaced by `-`
