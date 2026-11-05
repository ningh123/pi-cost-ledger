# Changelog

All notable changes to this project are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-11-05

### Added

- Bare `/cost` opens an interactive table for the current project, with today,
  the last 7 days, the last 30 days, and all time one key away. The plain-text
  panel also shows today, 7-day, and 30-day totals so the selected range is
  always anchored to the month.
- Project, provider, and provider/model scopes. Project and provider scopes
  group rows by provider and model; `v` pivots to project rows without changing
  the scope or total. A model scope lists every project where that model ran.
  Enter on a project row in project grouping focuses that project.
- `p`/`P` opens the project picker; `m` opens the provider/model picker. Pickers
  list every entity known from all time with its cost in the selected range, so
  an entity with no usage in the current range still appears at `$0`. `all
  projects` and `all providers` clear the corresponding scope; the provider/model
  picker is global and clears the project scope.
- `/` searches the current picker, or projects, providers, and models together
  from the table. Escape clears the query before it cancels the picker.
- `1`–`4` and `←`/`→` switch ranges in the table; `1`–`9` apply a picker option
  and `←`/`→` switch ranges inside a picker. In a search, digits type into the
  query. `↑`/`↓` select, `PgUp`/`PgDn` page by visible rows/options, `s` cycles
  the sort column, `r` re-reads the session files, and `q`/Escape quits.
- A pinned total row mirrors the active table columns and stays visible while
  rows scroll. Responsive columns keep `cost` and move lower-priority metrics to
  continuation lines instead of dropping them; provider names and the model
  indent keep a minimum label budget. Wide characters and emoji are measured by
  terminal columns.
- The panel keeps one height for the session, derived from the full ledger and
  capped at 20 lines and roughly 60% of the terminal. Short reports are padded
  instead of resizing the dock; on very short terminals the panel shrinks
  further and never occupies the last row.
- `/cost today|7d|30d|all [project|all]`, `/cost text [range] [scope]`, and
  `/cost refresh` print the plain-text panel. `/cost refresh` uses the saved
  plain-text scope outside the TUI; the interactive view always starts with the
  current project.
- `/cost default <range> [project|all]` persists the opening range and the
  plain-text default scope. Settings and the index are written atomically, and a
  missing settings or sessions directory is created or tolerated as appropriate.
- RPC mode receives the plain panel as a notification; print and JSON modes
  write it to stderr so stdout stays reserved for the model and JSON streams.
- Session logs are discovered under the default `<agent-dir>/sessions` root and
  the active configured session directory (`--session-dir`,
  `PI_CODING_AGENT_SESSION_DIR`, or the `sessionDir` setting), including flat
  directories that store `.jsonl` files directly.
- Assistant messages, tool results from nested calls, standalone `usage` entries
  (cache warming), and compaction/branch summaries are all counted, matching
  pi's own session totals. Tool results and summaries whose log entry names no
  model are grouped under `tools / summaries` rather than being attributed to
  the outer session model.
- An on-disk index stores one summary per session, folded into per-day,
  per-provider, per-model buckets. Files are re-read only when their size or
  mtime changes, and `/cost refresh` forces a full re-read.
- Forked and branch-extracted sessions count copied usage once across files.
  Dedupe uses the entry id plus its bucket and totals, because pi ids are short
  and unique only within a session, and groups byte-identical copies by session
  header id. Provenance ordering keeps copied history with the original project
  whenever the source file is still present.
- The index is strictly a cache. It is rebuilt when the local time zone, parser
  version, or index shape changes, and a deleted session is pruned. A session
  that is temporarily unreadable keeps its last indexed totals and produces a
  warning instead of disappearing from the report.
- Undated legacy usage entries fall back to the session header timestamp before
  the file mtime, so old logs land on a day closer to when they were written.
- Costs are what pi recorded when the call ran: catalog pricing or a
  provider-reported billed total where pi has one. History is never re-priced.
  Money formatting scales from four decimals below a cent through `k`, `M`, `B`,
  and `T` units, with explicit rounding boundaries.
- Cache rates are the cumulative `cacheRead / (input + cacheRead + cacheWrite)`
  share shown in pi's session info. Calls count usage-bearing records, including
  summaries and cache warming; all-zero records from failed calls are ignored.
- Ranges are whole local calendar days, including leap days and daylight-saving
  transitions, and future-dated records are excluded until their day starts.
- Labels from session logs and the index are stripped of terminal escape and
  control characters before rendering.
- The extension registers one command and performs no background work. It reads
  only local session logs and writes only its settings and usage index; it never
  talks to the network or reads credentials.
- The package declares pi's host packages as peer dependencies, ships every
  runtime module in its tarball, and is validated by type checking, Biome,
  Node's test runner, and a packaged-file assertion in CI.
