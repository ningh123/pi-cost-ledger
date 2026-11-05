# pi-cost-ledger

See what your pi sessions cost — from the logs pi already writes.

```text
Cost — today · ~/projects/atlas

$3.42 · 2.1M in / 480k out · cache 88% · 312 calls

today          $3.42  ↑2.1M ↓480k  88%
last 7 days   $14.80  ↑9.4M ↓2.1M  95%
last 30 days  $52.30  ↑38M ↓8.6M   96%

models
  anthropic    claude-opus-5-5   $2.90  85%   88%  ███████
  opencode-go  deepseek-v4-pro  $0.480  14%   87%  █
  openai       gpt-5.4          $0.040   1%   87%  █
```

`/session` tells you what one conversation used. `/cost` answers the bigger
questions: what today in this repo has cost so far, which model and project the
month went to, and whether your prompt cache is doing its job. It reads the
session logs under `~/.pi/agent/sessions`, keeps a small index next to them, and
never talks to the network.

The sample above is the plain-text form (`/cost today`); bare `/cost` opens the
interactive table described below. The figures are illustrative.

## Install

```bash
pi install npm:pi-cost-ledger
```

Restart pi (or run `/reload`), then run `/cost`.

## Quick start

| Goal | Command |
| --- | --- |
| Interactive view for this project, today | `/cost` |
| Plain text for today, 7 days, 30 days, or all time | `/cost today`, `/cost 7d`, `/cost 30d`, `/cost all` |
| Plain text for every project | `/cost 7d all` |
| Plain text with your saved defaults | `/cost text` |
| Change the defaults | `/cost default 7d all` |
| Re-read every session file | `/cost refresh` |
| List commands and number definitions | `/cost help` |

Bare `/cost` always opens with the current project, even when your saved
plain-text scope is `all`. `/cost text` and `/cost refresh` in non-interactive
modes use the saved range and scope; `/cost <range>` uses the saved scope
unless you pass one.

## The interactive view

```text
Project: ~/projects/atlas ▾                          1 today  2 7d  3 30d  4 all
────────────────────────────────────────────────────────────────────────────────
providers (3) · cost↓         in     out    cache r(w)    hit%   calls      cost
▸ anthropic                 1.2M    2.4M     17M(1.1M)   88.1%    1.1k    $18.50
    claude-opus-5-5         1.2M    2.4M     17M(1.1M)   88.1%    1.1k    $18.50
  opencode-go               600k    1.3M    8.0M(600k)   87.0%     500     $7.00
    deepseek-v4-pro         600k    1.3M    8.0M(600k)   87.0%     500     $7.00
  deepseek                  300k    500k    4.0M(300k)   87.0%     300     $2.00
    deepseek-v4-pro         300k    500k    4.0M(300k)   87.0%     300     $2.00
════════════════════════════════════════════════════════════════════════════════
  total                     2.1M    4.2M     29M(2.0M)   87.6%    1.9k    $27.50
↑↓ select · ←→ range · p project · m model · v group · / search · esc quit
```

The active scope and range lead the view. The table and its pinned total share
the same columns, in reading order: `in`, `out`, `cache r(w)`, `hit%`, `calls`,
`cost`. In provider grouping, models sit beneath their provider. Provider names
and the model indent are kept; other columns join as the terminal width allows,
and metrics that do not fit move to a continuation line instead of disappearing.
The view needs at least 18 columns. The pinned total stays visible while rows
scroll; it disappears when the report is empty or a picker is open.

`cache r(w)` is cache read, with cache write in parentheses when it is nonzero
(`17M` or `17M(1.1M)`). Hit rates use one decimal; a real but tiny rate shows
as `<0.1%`.

Usage whose log entry names neither a provider nor a model — some nested tool
results and compaction/branch summaries — appears as a `tools · summaries` row.
It is shown rather than guessed into a model, so the total still matches pi's
session totals.

Model ids are not unique across providers: the same model can be served by more
than one provider, or listed with different casing or a version suffix. Provider
and model are always shown together, and plain-text rows name the provider, so
two bills never merge.

### Keys

| Key | Effect |
| --- | --- |
| `1`–`4` | today, 7 days, 30 days, all time |
| `←`/`→` | previous/next range, in the table or an open picker |
| `p` / `P` | open the project picker |
| `m` | open the provider/model picker |
| `v` | switch between provider/model rows and project rows |
| `/` | search the current picker, or every scope from the table |
| `1`–`9` in a picker | apply an option immediately |
| `↑`/`↓` | select a row or option |
| `PgUp`/`PgDn` | page by visible rows/options |
| `enter` | apply a picker option; focus a project in project grouping |
| `s` | cycle the sort column without losing the selected row |
| `r` | re-read every session file from disk |
| `esc` | clear a search, cancel a picker, or quit the table |
| `q` | quit the table |

### Pickers, scopes, and search

`p`/`P` opens the project picker; `m` opens the provider/model picker. The
project picker lists every project the ledger has seen, and the provider/model
picker lists every provider and model. Each option shows its cost in the
current range — so an entity with no usage in this range still appears at `$0`
and remains selectable. The project picker pins `this project`.

`all projects` clears the project scope. `all providers` returns to all
projects, clearing both the provider/model scope and the project scope. The
provider/model picker is global: choosing a provider or model also clears the
project scope, so its option costs are all-project totals. Use `p` to narrow
back to a project.

Use `↑`/`↓` to move and Enter to apply, or press `1`–`9` to apply an option
immediately. While a picker is open, `←`/`→` switches the range and refreshes
the option costs; a range changed there stays changed after the picker closes.
Escape cancels the picker and restores the table.

Press `/` inside a picker to search its options. From the table, `/` searches
projects, providers, and models together; type to narrow the list, then Enter
applies the selected scope. Escape clears the query before it cancels the
picker. Digits in a search are typed into the query, not treated as shortcuts.

### Grouping

A project or provider scope groups rows by provider and model by default. `v`
pivots the same data to project rows without changing the scope, range, or
total. Provider grouping answers "which provider/model spent the money"; project
grouping answers "which project spent it" — all projects, or the per-project
breakdown of one provider.

A model scope is a cross-reference, not a tree: it always groups by project and
shows every project where that model ran. `v` does not apply there. Enter on a
project row in project grouping focuses that project and returns to the
provider/model table.

### Ranges and sorting

Ranges are whole local days: today, the last 7 days, the last 30 days, or all
time. `1`–`4` or `←`/`→` switch them in the table.

`s` cycles the sort column — cost, hit, calls, out, in, cache r, cache w. The
active column is shown after the section count. PageUp and PageDown move by
visible rows, and the footer adds `↓ more`, `↑ more`, or `↑↓ more` when rows are
outside the viewport. Scrolling keeps the selected provider and its model group
together when they fit.

### Small terminals

The panel keeps one height for the whole session: at most 20 lines and roughly
60% of the terminal, leaving room for the transcript and editor. Short reports
are padded rather than resizing the editor dock, so changing the range or scope
does not move the transcript. On narrow screens the range controls wrap or fall
back to `1 · 2 · 3 · 4`. On short or narrow terminals the separators and total
detail lines are dropped; on very narrow terminals only `cost` stays on the row
and every other metric moves to continuation lines. The panel shrinks further on
very short terminals and leaves at least one row for the editor on terminals
with two or more rows.

## Commands

| Command | Effect |
| --- | --- |
| `/cost` | interactive view for today, current-project scope |
| `/cost today` / `7d` / `30d` / `all` | plain-text panel for one range |
| `/cost <range> project\|all` | the same, with an explicit scope |
| `/cost text [range] [scope]` | plain-text panel using the saved defaults unless overridden |
| `/cost default <range> [scope]` | set the opening range and plain-text default scope |
| `/cost refresh` | re-read every session file, then open the view (text mode uses the saved scope) |
| `/cost help` | commands and how the numbers are produced |

Subcommands and arguments complete with Tab. The default range and text scope
are remembered across sessions. The interactive home stays the current project
regardless of the saved text scope.

RPC mode sends the plain panel as a notification; print and JSON modes write it
to stderr, because stdout is reserved for the model and JSON event streams.

## How it works

Pi keeps one append-only JSONL log per session under
`<agent-dir>/sessions/<encoded-cwd>/`, or under a configured session directory
(`PI_CODING_AGENT_SESSION_DIR`, `--session-dir`, or the `sessionDir` setting).
The ledger reads from both the default root and the active configured directory,
including flat directories that store `.jsonl` files directly.

Usage appears in four shapes in those logs: assistant messages, tool results
from nested model calls, standalone `usage` entries (cache warming), and the
summaries written for `/compact` and `/tree` branch switches. All four count, so
the totals match pi's own session totals. Tool results and summaries often carry
no provider or model attribution; when the log names neither, those records are
grouped under the synthetic `tools` / `summaries` row rather than being
attributed to the outer session model.

Each log is summarized by local day, provider, and model and stored in the agent
directory (by default `~/.pi/agent/cost-ledger.json`). A file is re-read only
when its size or modification time changes, so `/cost` after months of history
is a few hundred file checks and one parse of the session you are in.

Forked and branch-extracted sessions copy history from the original session,
including its usage records. The ledger counts each copied record once across
files and keeps copied history with its original project when that file is
present. Because pi record ids are short and unique only within a session,
dedupe also compares the day/provider/model and totals, and only compares copies
that belong to the same original session. Copies of the same file reached
through different paths are grouped by the session header id. If an intermediate
fork is deleted while a later fork and the original remain, that later copy can
no longer be linked and may be counted again.

The index is a cache. Delete it, or run `/cost refresh`, and it is rebuilt from
the logs. A failed index write is not an error: the next `/cost` simply
re-reads. A session that cannot be read right now (permission error, unavailable
mount) keeps its last indexed totals and the report warns; only a file that is
actually gone is pruned. The index stores one small usage record per call so
forks can be deduplicated; at roughly 100k calls it is about 15 MB. Deleting it
is always safe.

Nothing runs in the background. The extension registers one command and touches
disk only when you ask, so an idle pi process pays nothing for having it
installed.

## What the numbers mean

- **Cost** is what pi recorded when the call ran: token counts priced against the
  model table at that moment, or a provider-reported billed total where pi has
  one. A coding-plan subscription bills less than this, so read it as
  *equivalent API price* — useful for comparing models and projects, not as an
  invoice. Small amounts keep extra decimals so a cheap call does not read as
  `$0`; large amounts use `k`, `M`, `B`, and `T`. History is never re-priced, so
  a later price change does not rewrite past months.
- **Provider** is the provider identifier recorded by pi, or the synthetic
  `tools` provider for records that name neither a provider nor a model.
  Provider scope groups by that exact name; it does not infer subscriptions or
  billing accounts. If an entry names only one half of a provider/model pair,
  the other half is shown as `unknown` rather than guessed.
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
  the first visible day within that cap. The plain panel adds a daily trend line
  when the visible span is more than one day.
- **Scope** is one project (the working directory or a picked project), one
  provider, or one provider/model pair. Project and provider scope group rows by
  provider/model by default; `v` switches to project rows. Model scope always
  groups by project. Plain-text reports use only project or all-projects scope,
  and hide the project table when scoped to one project.
- **Ranges** are whole local calendar days, not rolling hours: "last 7 days" is
  today plus the six days before it. Days are local dates, so a machine that
  changes time zone rebuilds the index rather than mixing zones.

## Privacy and safety

Everything is computed locally. The extension reads only local session logs and
writes only its settings and usage index; it never talks to the network and
never reads credentials. Session-derived labels are stripped of terminal escape
and control characters before they are rendered.

## Troubleshooting

**Why do I see `tools` / `summaries`?**
Some usage entries name neither the provider nor the model that produced them —
nested tool calls and compaction/branch summaries. Attributing them to the outer
session model would be a guess, so they appear as the synthetic `tools` provider
and `summaries` model. Their tokens and cost still count toward the total and
match pi's own session totals.

**Why is the total different from my provider bill?**
Cost is pi's equivalent API price for the tokens used, not your invoice. A
coding-plan subscription, credits, or discounts bill differently. History is not
re-priced when prices change.

**A session disappeared from the report.**
Sessions deleted from disk are pruned from the index. A session that exists but
cannot be read right now keeps its last indexed totals and produces a warning
instead of vanishing.

**I forked a session and the spend looks wrong.**
Copied history is counted once across the original and its forks. If an
intermediate fork is deleted while a later fork and the original remain, that
later copy can no longer be linked and may be counted again.

**Can I delete the index?**
Yes. The index file (by default `~/.pi/agent/cost-ledger.json`) is only a cache;
delete it or run `/cost refresh`, and it is rebuilt from the logs. At roughly
100k calls it is about 15 MB.

**Do subagents count?**
Yes. Subagent children run as their own pi sessions, so their spend lands in the
same ledger automatically.

**Why did I get text instead of the interactive view?**
Print, JSON, and RPC modes have no keyboard or viewport, so they get the plain
panel.

**Nothing appears.**
If pi has no sessions under the agent directory yet, `/cost` says so instead of
showing an empty panel.

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
