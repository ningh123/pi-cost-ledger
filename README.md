# pi-cost-ledger

What your [pi](https://github.com/earendil-works/pi) sessions cost — from the
logs pi already writes:

```
Cost — today · ~/projects/atlas

$3.42 · 2.1M in / 480k out · cache 94% · 312 calls

today         $3.42  ↑2.1M ↓480k  94%
last 7 days  $14.80  ↑9.4M ↓2.1M  95%
last 30 days $52.30  ↑38M ↓8.6M   96%

models
  anthropic    claude-opus-5-5    $2.90  85%  96%  ████████
  opencode-go  deepseek-v4-pro    $0.48  14%  91%  █
  openai       gpt-5.4            $0.04   1%  88%  █
```

`/session` tells you what one conversation used; this tells you what *today in
this repo* has cost so far, which model and which project the month went to, and
whether your prompt cache is actually doing its job. It reads the session logs
under `~/.pi/agent/sessions`, builds a small index next to them, and never talks
to the network.

The view opens with the project pi is running in, even when the saved plain-text
scope is all projects. A single responsive table replaces view tabs and detail
screens: a project scope defaults to its providers and models, while a model
scope lists every project where that model ran. `p` picks a project scope, `m` a
provider/model scope, `v` switches grouping, and `/` searches all of them.

The panel keeps one height for the whole session — up to 20 lines and about 60%
of the terminal — and pads short reports instead of resizing the editor dock. The active scope and range lead the view; the table and its total
own all KPI columns. Rows use `in`, `out`, `cache r(w)`, `hit%`, `calls`, `cost`
order, and measured responsive layouts move lower-priority metrics into
continuation lines rather than dropping them.

Model ids are not unique across providers: `deepseek-v4-pro` is served by both
`deepseek` and `opencode-go`, and the same model can also be listed with different
casing or a version suffix. Interactive models sit beneath their provider, and
plain-text rows name it explicitly, so two bills never merge. The projects and
amounts below are illustrative.

## Install

```bash
pi install npm:pi-cost-ledger
```

Restart pi (or run `/reload`), then `/cost`.

## The interactive view

Bare `/cost` opens the scoped table with the current project. Usage reports are
aggregated in memory; each report checks the index on disk, stats the known
session files, and parses only the files that changed.

```
Project: ~/projects/atlas ▾                 1 today  2 7d  3 30d  4 all
────────────────────────────────────────────────────────────────────────────────
providers (3) · cost↓              in     out   cache r(w)   hit%   calls    cost
▸ anthropic                      1.2M    2.4M   17M(1.1M)   88.1%   1.1k  $18.50
    claude-opus-5-5             1.2M    2.4M   17M(1.1M)   88.1%   1.1k  $18.50
  opencode-go                    600k    1.3M   8.0M(600k)   87.0%    500   $7.00
    deepseek-v4-pro             600k    1.3M   8.0M(600k)   87.0%    500   $7.00
  deepseek                       300k    500k   4.0M(300k)   87.0%    300   $2.00
    deepseek-v4-pro             300k    500k   4.0M(300k)   87.0%    300   $2.00
════════════════════════════════════════════════════════════════════════════════
  total                        2.1M    4.2M   29M(2.0M)   87.6%   1.9k  $27.50
↑↓ select · ←→ range · p project · m model · v group · / search · esc quit
```

Only the active scope and range sit above the table; narrow screens wrap those
controls and fall back to `1 · 2 · 3 · 4` for the range. `cache r(w)` shows cache
read, with cache write in parentheses only when it is nonzero—for example, `17M`
or `17M(1.1M)`. Cache hit rates use one decimal, with `<0.1%` for a real but very
small rate. There are no Provider/Model tabs and no Enter-details action.

`p`/`P` opens the project picker; `m` opens the provider/model picker. Options
list every entity known from all time with its cost in the selected range, so a
project, provider, or model with no usage in the current range still appears at
`$0` and remains selectable. `all projects` and `all providers` clear the
corresponding scope; `all providers` also clears a provider/model scope. The
project picker pins `this project`; every picker uses the same responsive columns
as the table. The marker and `1`–`9` shortcut take two extra columns, so labels
truncate slightly sooner. Press `1`–`9` to apply an option immediately, or move with
`↑`/`↓` and press Enter. While a picker is open, `←`/`→` switch the range and
refresh its option costs. Digits in a search are typed into the query instead.
Escape cancels the picker and restores the table; a range changed inside the
picker with `←`/`→` stays changed. The provider/model picker is global: choosing
a provider or model clears the project scope, so its option costs are
all-project totals. Use `p` to narrow back to a project.

Press `/` inside a picker to search its options. From the table, `/` searches
projects, providers, and models together; type to narrow the list, and Enter
applies the selected scope. Escape clears the query before it cancels the
picker.

A project or provider scope groups rows by provider and model by default; `v`
switches that table to project rows. `v` is a pivot, not a filter: the scope,
range, and total stay the same; only the row dimension changes. Provider
grouping answers "which provider/model spent the money"; project grouping
answers "which project spent it" (all projects, or the per-project breakdown of
one provider). A model scope is a cross-reference, not a tree: it always groups
by project and shows every project where that model ran, with the same columns
and total. Enter on a project row in project grouping focuses that project and
returns to the provider/model table.

The panel keeps a fixed height for the session, derived from the full ledger
when the view opens: at most 20 lines and roughly 60% of the terminal, leaving
room for the transcript and editor. On very short terminals the panel shrinks
further and leaves at least one row on terminals with two or more rows. Short
reports are padded in the body so the total and footer stay pinned; changing
the range or scope does not resize the editor dock. On short or narrow terminals the separators and total detail
lines are dropped. On very narrow terminals only `cost` stays on the row and
every other metric moves to continuation lines; the view requires at least 18
columns.

The table separates reading order from responsive priority. Reading order is
`in`, `out`, `cache r(w)`, `hit%`, `calls`, `cost`, with priced cost last. Layout
is measured rather than tied to fixed terminal-width tiers: `cost` always
remains on the row, `hit%` joins when the label still has room, and `calls`,
`cache r(w)`, `out`, and `in` join as their real widths fit. A minimum label
budget preserves provider names and the four-column model indent; all remaining
space goes to the label.

Metrics that do not fit move to secondary lines instead of disappearing. Every
entity therefore has one primary row and only as many continuation lines as its
current width requires. The pinned total uses exactly the same layout and stays
visible while the table scrolls; it disappears for empty reports and while a
picker is open. PageUp and PageDown move by visible rows/options, and scrolling
keeps the selected provider and its model group together when they fit.

There is no daily sparkline in the interactive view. `s` cycles the sort column
(`cost`, `hit`, `calls`, `out`, `in`, `cache r`, `cache w`); the active metric is
shown after the section count.

Use `/cost default <range> [project|all]` to persist the opening range and the
default scope for explicit plain-text reports. Bare `/cost` still opens with the
current-project scope. When there are rows outside the viewport the footer adds
`↓ more`, `↑ more`, or `↑↓ more`.

| Key | Effect |
| --- | --- |
| `1`–`4` | switch between today, 7 days, 30 days, and all time in the table |
| `←`/`→` | switch the range in the table, or inside an open picker |
| `p` / `P` | open the project picker |
| `m` | open the provider/model picker |
| `v` | switch between provider/model and project grouping |
| `/` | search the current picker, or every scope from the table |
| `1`–`9` in a picker | apply an option immediately; digits type into a search query |
| `s` | cycle the sort column without losing the selected row |
| `↑`/`↓` | select a provider, project, or picker option |
| `PgUp`/`PgDn` | page by visible rows/options |
| `enter` in a picker | apply the selected option |
| `enter` in project grouping | focus the selected project |
| `esc` | clear a search, cancel a picker, or quit the table |
| `q` | quit the table |
| `r` | re-read every session file from disk |

A range argument — `/cost 7d` — skips the view and prints the plain panel, which
is the copyable form and the only form outside the TUI. Add `all` after the range
to widen the scope: `/cost 7d all`.

## Commands

| Command | Effect |
| --- | --- |
| `/cost` | interactive view, today, current-project scope |
| `/cost today` / `7d` / `30d` / `all` | plain-text panel for one range |
| `/cost <range> project\|all` | the same, with an explicit scope |
| `/cost text [range] [scope]` | plain-text panel for the default view |
| `/cost default <range> [scope]` | set the opening range and plain-text default scope |
| `/cost refresh` | re-read every session file, then open the view (text mode uses the saved scope) |
| `/cost help` | commands and how the numbers are produced |

Subcommands and arguments complete with Tab, and the default range and text
scope are remembered across sessions. The interactive home remains the current
project regardless of the saved text scope. RPC mode sends the plain panel as a
notification; print and JSON modes write it to stderr, since stdout is reserved
for the model and JSON event streams.

## How it works

Pi keeps one append-only JSONL log per session under
`<agent-dir>/sessions/<encoded-cwd>/`, or under a configured session directory
(`PI_CODING_AGENT_SESSION_DIR`, `--session-dir`, or the `sessionDir` setting).
Usage appears in four shapes in those logs, and the ledger counts all of them,
matching pi's own session totals: assistant messages, tool results from nested
model calls, standalone `usage` entries (cache warming), and the summaries
written for `/compact` and `/tree` branch switches. The log does not record
which model produced a tool result or summary, so those records are grouped
under the synthetic `tools` / `summaries` bucket rather than being attributed to
the outer session model.

Each log is folded into buckets keyed by local day, provider, and model and
stored in `~/.pi/agent/cost-ledger.json`. A file is re-read only when its size or
mtime changed, so `/cost` after months of history is a few hundred `stat` calls
and one parse of the session you are in. Forked and branch-extracted session
files copy history with the original entry ids; the ledger counts each copied
usage entry once across files and keeps copied history with its original project
when that file is present. Because pi entry ids are short and unique only within
a session, dedupe also compares the bucket and totals, so an id collision
between unrelated sessions never drops real spend. Byte-identical copies that
share a session header id are grouped even when reached through different paths.
The index is a cache: delete it, or run `/cost refresh`, and it is rebuilt from
the logs.

A session that cannot be read right now (permission error, unavailable mount)
keeps its last indexed totals and the report warns; only a file that is actually
gone is pruned. The index stores one compact usage record per call so forks can
be deduplicated; at roughly 100k calls it can reach tens of megabytes, and
deleting it is always safe.

Nothing runs in the background. The extension registers one command and touches
disk only when you ask, so an idle pi process pays nothing for having it
installed.

## What the numbers mean

- **Cost** is what pi recorded when the call ran: token counts priced against the
  model table at that moment, or a provider-reported billed total where pi has
  one. A coding-plan subscription bills less than this, so read it as
  *equivalent API price* — useful for comparing models and projects, not as an
  invoice. History is never re-priced, so a later price change does not rewrite
  past months.
- **Provider** is the provider identifier recorded by pi, or the synthetic
  `tools` provider for records whose log entry names no model. Provider scope
  groups by that exact name; it does not infer subscriptions or billing accounts.
- **Tokens** are provider-reported: `↑` input, `↓` output. Cache reads and writes
  are separate counters and are not folded into input.
- **Cache** is `cacheRead / (input + cacheRead + cacheWrite)`, the cumulative
  share shown in pi's session info (the footer's `CH` value is only the latest
  call). On subscription plans it is the single biggest cost lever: a prefix
  that keeps changing re-prices the whole conversation.
- **Calls** counts usage records — one per usage-bearing entry, including
  summaries and cache warming. All-zero records from failed calls are ignored.
- **Trend** covers the selected window, capped at the last 30 calendar days, so
  a quiet week is visible as a gap rather than as a missing bar; `all` starts at
  the first visible day within that cap.
- **Scope** is one project (the working directory or a picked project), one
  provider, or one provider/model pair. Project and provider scope group rows by
  provider/model by default; `v` switches to project rows. Model scope always
  groups by project. Plain-text reports still use only project or all-projects
  scope, and hide the project table when scoped to one project.
- **Ranges** are whole local calendar days, not rolling hours: "last 7 days" is
  today plus the six days before it. Day buckets are local dates, so a machine
  that changes time zone rebuilds the index rather than mixing zones.

## Notes

- Sessions deleted from disk disappear from later reports; the index prunes them.
- Forked or branch-extracted sessions count copied usage once. Dedupe uses the
  entry id plus its bucket and totals, because pi ids are short and only unique
  within a session. It follows `parentSession` links; if an intermediate fork is
  deleted while a later fork and the original remain, that later copy can no
  longer be linked and may be counted again.
- Tool results and compaction/branch summaries without model metadata appear
  under `tools / summaries`; their totals still match pi's session totals.
- A session source that is temporarily unreadable keeps its last indexed totals
  and produces a warning; a deleted file is pruned.
- Subagent children run as their own pi sessions, so their spend lands in the
  same ledger by itself.
- A failed index write is not an error: the next `/cost` simply re-reads.
- Everything is computed locally. Nothing is uploaded, and no credential is read.
- Session-derived labels are stripped of terminal escape and control characters
  before they are rendered.

## Development

```bash
npm install
npm test        # node --test
npm run typecheck
npm run lint    # biome
npm run format  # biome check --write
```

## License

MIT © 2026 Ning. See [LICENSE](LICENSE).
