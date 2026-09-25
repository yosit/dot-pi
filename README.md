# dot-pi

My [pi](https://pi.dev) setup as a pi package: a Claude-Code-style statusline, and a set of guardrails for the coding loop powered by **[TypeSafe](https://typesafe.ai) Jev** — a fast classifier that returns typed decisions with calibrated probabilities in ~70-500ms for a fraction of a cent.

| Extension | Hook | What it does |
|---|---|---|
| [`statusline`](#statusline) | footer | dir · branch · model · thinking · context vs compaction point · cache hit · lines changed · cost |
| [`autothink`](#autothink) | `input` | Picks the thinking level for each prompt |
| [`settle-gate`](#settle-gate) | `agent_before_settle` | Sends unverified "done" claims back to verify; redirects plain-text questions to `AskUserQuestion` |
| [`loop-detector`](#loop-detector) | `turn_end` | Notices a failing retry loop, tells the agent to step back, raises thinking |

## Why Jev, and where not

Jev does **bounded judgments** on text — "which of these 4?", "is this true?" — not generation, arithmetic, counting, or dates. Every extension here follows the same split:

- **Code owns the facts.** Did a file change after the last `bun run check`? Did that run exit non-zero? Is it the same failing command three times? Deterministic, tracked from tool events.
- **Jev owns the language.** Does this message *claim* the work is done? Does it *end with a question*? Does this tool history *look stuck*?
- **Everything fails open.** No key, timeout, 5xx → no opinion, no nudge. A guardrail that blocks you because a classifier is down is worse than none.
- **Nothing that busts the prompt cache.** No per-prompt tool, system-prompt, or model switching. Thinking level and appended messages only.

## Setup

**1. Install the package**

```bash
git clone git@github.com:yosit/dot-pi.git ~/code/dot-pi
cd ~/code/dot-pi && bun install          # dev deps only (typecheck/tests)
pi install ~/code/dot-pi                  # adds it to ~/.pi/agent/settings.json
```

Then `/reload` in a running pi (or restart). `pi list` should show it.

To load only some extensions, use the object form in `~/.pi/agent/settings.json`:

```json
{ "packages": [{ "source": "/Users/you/code/dot-pi", "extensions": ["extensions/statusline.ts", "extensions/autothink.ts"] }] }
```

**2. TypeSafe API key** (everything except `statusline` needs it)

Create a key at <https://console.typesafe.ai/settings/keys>. The client looks for it in this order (a found key is cached for the pi process; a miss is retried on the next call):

1. `TYPESAFE_API_KEY` environment variable
2. global [psst](https://github.com/Michaelliv/psst) vault: `psst --global set TYPESAFE_API_KEY`
3. the psst vault of the directory pi was started in

Use the **global** vault — psst does not fall back from a project vault to the global one, so a project-only key silently disables the extensions everywhere else.

**3. `AskUserQuestion` tool** (for settle-gate's ask rule)

```bash
pi install git:github.com/Michaelliv/pi-ask-user-question
```

The ask rule only runs when a tool with that name is active; change `settleGate.ask.toolName` if yours differs.

**4. Optional config** — `~/.pi/agent/dot-pi.json`, overridden per project by `<repo>/.pi/dot-pi.json` (deep-merged; arrays replace). All fields optional; see [`src/config.ts`](src/config.ts) for defaults and [`examples/dot-pi.json`](examples/dot-pi.json).

**5. Optional compaction point** — the statusline shows it; to move it (e.g. Opus 5.5's 1M window compacting at 400k), add [`examples/settings.compaction.json`](examples/settings.compaction.json) to `~/.pi/agent/settings.json`. Pi compacts above `contextWindow − reserveTokens`.

## Extensions

### statusline

```
 vex  main● ↑1  ⚡Claude Opus 5.5 🧠high  ▮▮▯▯▯▯▯▯ 27% 108k/⟳400k/1M  ♻92%  ✚12 ✖3  💲1.84  🧠auto 91% 240ms
```

| Segment | Source |
|---|---|
| `vex` | cwd basename |
| `main● ↑1 ↓0` | branch, `●` dirty, ahead/behind upstream (refreshed each turn and on branch change) |
| `⚡model 🧠high` | current model and thinking level (hidden when off) |
| `▮▮▯▯ 27%` | context used **as a share of the auto-compaction point** — 100% means compaction is next. Green → cyan (40) → yellow (70) → red (90) |
| `108k/⟳400k/1M` | used / compaction point / full window. Without auto-compaction: `used/window` |
| `♻92%` | cache hit: cached input ÷ all input, over the session |
| `✚12 ✖3` | lines changed by successful edit/write calls in this pi process (a `write` counts all lines as added) |
| `💲1.84` | session cost |
| trailing | status text from other extensions (`ctx.ui.setStatus`) |

The compaction point mirrors pi's own resolution: `compaction.modelOverrides["provider/id"].reserveTokens` → `compaction.reserveTokens` → 16384, project settings over user. Cached per model; `/reload` after editing settings.

### autothink

Before each prompt you type, Jev rates how much reasoning it needs — `minimal` / `low` / `medium` / `high` — and pi's thinking level is set to match.

- Sees your prompt plus the tail of the previous assistant message, so `yes do it` after a big refactor proposal rates `high`, and `yes` to "push it?" rates `low`.
- Under 60% confidence (`confidenceFloor`) it takes the **higher** plausible level: under-thinking a hard task costs more than over-thinking an easy one.
- Skips `/commands`, `!shell`, steering messages sent mid-run, and non-reasoning models.
- Adds one Jev round trip (~270ms p50) before each turn.
- It sets the level on every prompt, so a level you pick by hand lasts one prompt. `/autothink off` pins your manual choice for the session.

### settle-gate

Runs when the agent is about to hand control back. One Jev call reads the final message; two rules:

**verify** — enforces "run the verification gate before reporting completion" and "never claim tests pass when they failed":

| Facts (tracked in code) | Message says (Jev) | Action |
|---|---|---|
| files edited after the last verification run, or none ran | work is done, or checks pass | sent back: run the gate and report the real result |
| last verification run failed, nothing edited since | checks pass | sent back: fix it or report the failure plainly |
| anything else | — | nothing |

A verification run is a `bash` call matching `settleGate.verify.commands` (defaults: `bun|npm|pnpm|yarn [run] check|test|lint|typecheck|build`, `tsc`, `cargo test|check|clippy`, `go test|vet`, `pytest`, `make test|check`). A non-zero exit is a failure. If no file changed, Jev is never called.

**ask** — enforces "drive decisions through `AskUserQuestion`": if the message ends with a plain-text *offer* ("want me to commit?"), *decision* ("A or B?") or *clarification* question, the agent is sent back to ask it through the tool. Statements and rhetorical questions pass.

Guarantees: at most **one** nudge per user prompt (it cannot loop), verify wins over ask, it stays out of the way if another extension already continued the run, and the ask rule only runs when there is a UI and the tool is active. `/settle-gate off` to disable.

### loop-detector

After each tool-using turn:

1. **Exact repeat** (code): the same tool call with the same input failed three times in a row → nudge.
2. **Fuzzy loop** (Jev): once `minErrors` (3) of the last `window` (6) tool results are errors, Jev classifies the trajectory as `progressing`, `exploring`, or `stuck`. `stuck` at ≥ 0.7 → nudge.

The nudge tells the agent to stop, state what the failures taught it, list two or three root-cause hypotheses, and pick one before trying again — and raises the thinking level to `high` if it was lower. Then it cools down for `window` tool results. Resets on each new prompt. `/loop-detector off` to disable.

## Tuning with the decision log

Every Jev decision is appended to `~/.pi/agent/dot-pi/decisions.jsonl` (set `typesafe.logFile` to `""` to disable): the input excerpt, the full probability distribution, the facts, the action taken, latency.

```bash
# every nudge settle-gate sent
jq -c 'select(.ext=="settle-gate" and .action!="none") | {action, message}' ~/.pi/agent/dot-pi/decisions.jsonl
# autothink: how often it changed your level, and to what
jq -r 'select(.ext=="autothink") | "\(.previous) -> \(.applied)"' ~/.pi/agent/dot-pi/decisions.jsonl | sort | uniq -c
# latency
jq -s 'map(.latencyMs // empty) | sort | {p50: .[length/2|floor], max: .[-1]}' ~/.pi/agent/dot-pi/decisions.jsonl
```

TypeSafe's published accuracy (~68% on their own benchmark) is self-reported. Before changing a threshold, add the misjudged real case to [`scripts/eval.ts`](scripts/eval.ts) and run it; pin `typesafe.model` to a version (default `jev-1.13.0`) so thresholds don't drift when `jev-latest` moves.

## Development

```bash
bun run check    # tsc + unit tests (no network)
bun run eval     # labeled examples against the live Jev API (needs the key)
```

Layout: `extensions/` are thin pi wiring (loaded by pi via the `pi.extensions` glob in `package.json`); `src/` holds the pure decision logic and the Jev client, unit-tested in `tests/`. Pi loads TypeScript directly — no build step.
