---
name: testing-feedback
description: Don't mock the database in integration tests
type: feedback
---

Integration tests must hit a real database, not mocks.

**Why:** Prior incident where mock/prod divergence masked a broken migration.
**How to apply:** Use real SQLite in integration tests.
