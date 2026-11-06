# Per-PR notes

Wave-2 agents work in parallel. To avoid editing the shared docs
(`AGENTS.md`, `systemdesign.md`, `ux.md`) on every branch:

- Write your design notes, trade-offs, and follow-ups to
  `docs/notes/PR-<n>.md` (for example `docs/notes/PR-4.md`).
- Exceptions: PR 0, PR 1, and PR 10 may edit the shared docs directly.
- PR 10 folds the per-PR notes into the shared docs.

Keep notes short and factual. Link to tests and file paths where useful.
