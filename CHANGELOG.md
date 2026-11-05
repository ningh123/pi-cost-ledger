# Changelog

All notable changes to this project are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-11-05

### Added

- `/cost` opens an interactive cost table for the current project, with today,
  the last 7 days, the last 30 days, and all time one key away. A pinned total
  stays visible while rows scroll.
- Project, provider, and provider/model scopes, plus a `v` pivot between
  provider/model and project rows. A model scope shows every project where that
  model ran; Enter on a project row focuses it.
- `p`/`P` opens the project picker and `m` opens the provider/model picker. Both
  list every entity the ledger has seen with its cost in the selected range, so
  an entity with no usage in the current range still appears at `$0`.
  `all projects` and `all providers` clear scopes; the provider/model picker is
  global and clears the project scope.
- `/` searches the current picker, or projects, providers, and models together
  from the table. Escape clears a query before it closes the picker.
- Keyboard controls: `1`–`4` and `←`/`→` switch ranges; `1`–`9` apply picker
  options; `↑`/`↓` and `PgUp`/`PgDn` navigate; `s` cycles sort columns; `r`
  re-reads session files; `q`/Escape quit.
- The table adapts to terminal width, keeping cost on the row and moving
  lower-priority metrics to continuation lines instead of dropping them. The
  panel keeps one height for the session, pads short reports, and needs at least
  18 columns.
- Plain-text reports show a headline, a today/7-day/30-day overview, the model
  breakdown with provider names, and the project breakdown when the scope is all
  projects. Multi-day ranges also show a daily trend line.
- `/cost today|7d|30d|all [project|all]`, `/cost text [range] [scope]`, and
  `/cost refresh` print the plain panel. `/cost default` saves the opening range
  and plain-text scope. Subcommands complete with Tab.
- RPC mode receives the plain panel as a notification; print and JSON modes
  write it to stderr so stdout stays reserved for model and JSON output.
- Session logs are discovered in the default agent sessions directory and the
  active configured session directory, including flat `.jsonl` directories.
- Usage from assistant messages, nested tool results, standalone usage entries,
  and compaction/branch summaries is counted, matching pi's session totals.
  Records that name neither a provider nor a model appear under `tools` /
  `summaries`.
- An on-disk index caches per-session totals and re-reads only changed files;
  `/cost refresh` forces a full re-read. The index is safe to delete.
- Forked and branch-extracted sessions count copied usage once across files,
  including copies reached through different paths.
- A deleted session is pruned; a temporarily unreadable session keeps its last
  indexed totals and produces a warning. The index rebuilds when the local time
  zone changes.
- Cost is what pi recorded at call time (equivalent API price), never re-priced.
  Cache hit rate is cumulative; calls count usage records and ignore all-zero
  failed calls. Ranges are whole local calendar days.
- Everything is computed locally: no network access, no credentials, no
  background work, and session-derived labels are sanitized before rendering.
