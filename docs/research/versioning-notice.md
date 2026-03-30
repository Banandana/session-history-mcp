# Versioning Notice

## Research Baseline

All research documents in this directory were produced against **Claude Code v2.1.87** (2026-03-30).

Session JSONL files include a `version` field on every message (e.g., `"version": "2.1.87"`), so the data is self-documenting regarding which version produced it.

## Known Version-Sensitive Details

The following behaviors were observed to vary across versions already present in local session data:

- **Subagent meta.json files**: only present in sessions from v2.1.80+ (older sessions have .jsonl only, no .meta.json)
- **Agent ID format**: older sessions use 7-char hex IDs, v2.1.80+ uses 17-char hex IDs
- **Special agent prefixes**: `acompact-` and `aprompt_suggestion-` prefixed agent IDs appear in newer versions for internal housekeeping agents
- **sessions-index.json**: existence and field completeness may vary by version

## Future Maintenance

When upgrading Claude Code or investigating parsing issues:

1. Check `npm view @anthropic-ai/claude-code versions` for recent releases
2. Review the changelog at https://github.com/anthropics/claude-code/releases or `npm view @anthropic-ai/claude-code --json` for change notes
3. Compare JSONL structure from new-version sessions against the schemas documented here
4. The `version` field in session messages makes it possible to handle format differences per-version if needed

## Adapter Implications

The data client's source adapters should:
- Read the `version` field from session messages
- Handle missing fields gracefully (older versions may omit fields that newer versions include)
- Log warnings when encountering unknown message types or fields (signals a format change)
- Not hard-fail on version differences — degrade gracefully
