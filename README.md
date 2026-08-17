# claimrot

Monitor `(claim, source_url)` pairs and find out which claims have quietly
stopped being true.

## The problem

Link rot has a name and tooling. Claim rot has neither. Every system that
cites a source — a RAG index, a generated article, a docs page quoting an
external API's limits, a comparison site — produces assertions that stop
being true while the link keeps resolving. As this hackathon's own brief puts
it: *"You write a scraper, it works, and a week later the site changes its
layout and everything breaks quietly."* Nobody monitors this today, because a
scraper per source rots faster than the facts do, so the monitoring costs
more than the staleness — unless the scraper can heal itself.

## The two rules

**Heal fires on blindness, never on change.** A recheck against a live page
has three honest outcomes, not two: the value still matches, the value has
changed (a finding), or nothing could be extracted at all (a question about
our own eyesight, not a finding). The scar behind this rule: a prior pipeline
shipped a confidently false refutation into two published documents because a
literal search for `$115` missed markup that split the `$` from its digits —
the system read "I can't find it" as "it's gone." Without this rule, every
site redesign reports as "the operator deleted this," the false-positive rate
goes through the roof, and nobody trusts the alerts by week two. So an empty
extraction never becomes a verdict on its own — it triggers a heal (via
Bright Data Scraper Studio), and only a *healed* collector that still finds
nothing is allowed to report `REMOVED`.

**Anchor on the label, verify the value.** Never search a page for the value
you expect — search for the label that governs it, then read what that label
says now. The scar: a real operator's NZ$59 was the adult fare, and later
became the *senior* fare. The number never left the page. A checker asking
"is 59 still there?" answers yes forever, and a genuinely stale claim survives
undetected. A checker asking "what does *Adult* say now?" catches it
immediately. This is why every assertion stores an anchor — a governing label
and its enclosing context — never just a bare value, and why scoring a
candidate is explicitly forbidden from looking at the candidate's own value
(`src/resolve/score.ts`) until after the anchor has already decided which
candidate is the right one.

## Why Scraper Studio is central

Self-healing extraction isn't a performance feature here — it's what makes a
*negative* result believable at all. The reference corpus behind this project
(2,572 claims, 942 source URLs, 352 distinct hosts — docs/design.md §9) lives
in a separate content repository as one fact-pack JSON file per guide and
ships with none of this repository; `ingest` expects you to point it at your
own `*.facts.json` files. A monitor that can't tell "this
page redesigned and our collector went blind" apart from "this fact was
genuinely removed" produces a false `REMOVED` on every redesign across that
whole tail, and a monitor whose negatives can't be trusted is worse than no
monitor. Bright Data Scraper Studio is what keeps the collectors alive across
that tail without a person rewriting selectors by hand every time a site
ships new markup.

We probed this live before building on it (`docs/probes/2026-08-17-scraper-studio.md`,
against `whalewatch.co.nz`, a real operator site in the corpus) and confirmed
three things the design depends on:

- A collector run returns a genuine **array** of labelled candidates, not a
  single flattened value per field — required for the anchor-and-score
  resolution in §4.4 of the design doc to have anything to work with.
- `scraper heal` accepts a prompt built purely from *our own* description of
  an empty result — no synthetic error has to be manufactured to trigger a
  heal on blindness.
- `scraper heal --auto-approve` **without** `--auto-save` returns
  `status: "done"` while silently discarding the fix — the only difference in
  the envelope is whether `"save_new_template"` appears in `completed_steps`.
  This is a real trap the probe caught before it shipped: `src/collect/studio.ts`'s
  `healCollector` always passes both flags together and checks
  `completed_steps`, never `status`, to decide whether a heal actually
  persisted.

The probe also found a real limitation worth stating plainly: an AI-authored
collector, even one explicitly prompted for "every price on the page as a
list," under-collects prices that sit in prose rather than in a table — see
Limitations below.

## Quickstart

```bash
npm install
npm run build

# Reduce prose claims from a fact pack into structured, testable assertions.
# Calls Claude once per claim, then never again for that claim — this step
# needs an Anthropic API key (ANTHROPIC_API_KEY).
npm run cli -- --db claimrot.db ingest 'path/to/*.facts.json'

# Run the engine: fetch each due claim's source via its collector, resolve
# candidates against the stored anchor, heal on blindness, record a verdict.
# No model calls happen here — every check after ingest is a deterministic
# comparison against a structured record, not a fresh model call.
npm run cli -- --db claimrot.db check

# Print drift receipts (defaults to DRIFTED; pass --verdict to filter).
npm run cli -- --db claimrot.db report --verdict DRIFTED

# Corpus-wide half-life analysis (see Limitations — this needs the full
# corpus to mean anything, not a handful of claims).
npm run cli -- --db claimrot.db study
```

`check` and `report` need no credential beyond whatever Bright Data
credential Scraper Studio collectors were created under; only `ingest` needs
`ANTHROPIC_API_KEY`.

## Example output

`examples/` is a **genuine, committed run**, not a fabricated sample. The
machine that produced it has a working Bright Data credential but no
Anthropic API key, so it exercises every stage of the pipeline except one:

- **Skipped, and covered instead by unit tests
  (`tests/ingest/normalize.test.ts`):** the Claude-backed prose-to-assertion
  reduction that `ingest` normally performs. In its place, `examples/assertions.json`
  holds four assertions transcribed by hand from the real structure of
  `https://whalewatch.co.nz/your-experience/our-tours/whale-watch-tour/`
  (verified live and recorded verbatim in `docs/probes/2026-08-17-scraper-studio.md`),
  inserted straight into a scratch SQLite DB against the schema in
  `src/db/schema.sql`, bypassing `ingest` entirely. Two of the four
  assertions are deliberately counterfactual prior claims — a stale price and
  a price the page never carried — chosen specifically to exercise the
  `DRIFTED` and blindness/heal branches against a real, unaltered collector
  response, never to fake one.
- **Genuinely exercised, end to end, against the live page:** the real
  Scraper Studio collector created during the probe (`c_msx2l16bsipcs0zz`),
  the real engine (`checkAssertion` in `src/engine/check.ts` — the identical
  function the `check` CLI command calls), real scoring and resolution
  (`src/resolve/`), and the real `report` CLI command. Two assertions
  resolved `HOLDS` (label and value both matched the live page), one resolved
  `DRIFTED` (the label matched but the asserted value didn't — the real page
  says NZ$175, the planted stale claim said NZ$170), and one exercised the
  blindness branch: no candidate anchored on "Senior" because the page has no
  senior price, which correctly triggered a heal call to the live collector
  rather than an immediate negative.
- **Why this ran through a driver script and not `claimrot check` itself:**
  `src/collect/registry.ts`'s entries are placeholder collector IDs (e.g.
  `c_whalewatch`) waiting to be filled in from each host's own
  `bdata scraper create` output — `whalewatch.co.nz` hasn't been provisioned
  that way yet, only the separate collector the probe created
  (`c_msx2l16bsipcs0zz`) has. So `examples/produce-output.ts` calls the real,
  unmodified `checkAssertion` engine (`src/engine/check.ts`) directly with
  that real collector ID, rather than going through `claimrot check`, which
  would have resolved the placeholder and failed. See Limitations.
- **What the heal call itself showed:** an earlier heal in this same session
  was interrupted locally by a client-side timeout while still running on
  Bright Data's servers, which then held the collector locked
  (`"Another refactor job is still in progress"`, HTTP 409) for the rest of
  the session. Every retry documented in `examples/heal-attempts.log` hit
  that same lock. The engine's response to a heal it cannot complete is
  exactly what the design requires: `UNVERIFIABLE`, never a fabricated
  `DRIFTED` or `REMOVED` — see `src/engine/check.ts`'s `unverifiable(...)`
  branch. So this run did not reach a clean `REMOVED` outcome, but it did
  demonstrate, with a real failure and not a staged one, that a heal failure
  degrades to "we don't know," not to a false finding.

Files:

- `examples/assertions.json` — the four hand-authored input assertions, with
  notes on which branch each one targets and why.
- `examples/produce-output.ts` — the driver that inserted them and ran the
  real engine and collector against the live page. Reproducing it hits the
  live Bright Data API and costs time and credits; it's committed as a record
  of what happened, not as a script meant for casual re-runs. Running it
  writes `examples/demo.db`, the actual SQLite database (claims, assertions,
  verdicts with full evidence, in the schema described in docs/design.md §6)
  — not committed, since the repo's `.gitignore` excludes all `*.db` files;
  `output.json` below is that database's verdicts table, exported.
- `examples/output.json` — the verdict rows from `demo.db`, exported as
  structured JSON: claim id, claim text, source, verdict, confidence, and
  timestamp at the top level, plus an `evidence` object nesting the chosen
  candidate, the full contender list, and the reason string — the example
  structured output the hackathon rules require. Five rows, not four: the
  "Senior" blindness claim was checked twice (see above), and both real
  attempts are included rather than only keeping the one that reads more
  cleanly.
- `examples/report.txt` — the real stdout of the `report` CLI command
  against `demo.db`, with the invoking commands shown, run once per verdict
  present in it (`--verdict DRIFTED`, `--verdict HOLDS`,
  `--verdict UNVERIFIABLE`).
- `examples/heal-attempts.log` — the raw transcript of the heal lock above,
  for anyone who wants to see the actual failure rather than take the summary
  on faith.

## Limitations

- **The half-life study awaits a full corpus run.** Design doc §9 specifies a
  measured half-life across the reference corpus's 2,572 claims; producing
  that number requires running `ingest` over the full corpus, which requires
  the Anthropic API key this machine doesn't have. No half-life figure is
  quoted anywhere in this repository. Do not infer one from the four-claim
  example above — a sample that small proves the mechanism works, not what
  the corpus-wide decay rate is.
- **`flagBlobCandidates` is a token-structural heuristic**, not a semantic
  one (`src/collect/studio.ts`). It screens out a candidate whose label
  matches more than one distinct known anchor, on the reasoning that such a
  label is probably a blob a collector mis-extracted rather than a genuine
  single value. Its known false positive: a real two-axis pricing grid, where
  a cell genuinely labelled "Adult Weekday" sits under separate row/column
  anchors "Adult" and "Weekday", gets screened out — both anchors are
  token-subsets of the label, so it reads as a blob. This fails toward
  `UNVERIFIABLE`, never toward a false verdict: a screened-out candidate is
  blindness to the engine, which triggers a heal rather than silently picking
  the wrong price.
- **`CONFLICT` is specified (design doc §4.6, §4.7) but not implemented.**
  The corpus carries exactly one source per claim, so there is nothing for a
  claim to disagree with itself about yet. The scoring and resolution code
  has no path that could currently produce it.
- **`src/collect/registry.ts`'s per-host collector IDs are placeholders**
  (`c_fareharbor`, `c_realnz`, `c_whalewatch`, and so on) waiting to be
  filled in from each host's own `bdata scraper create` run — none of them
  are real Bright Data collector IDs yet on this machine. So `check` today
  resolves candidates for real only on hosts you've actually provisioned,
  plus the unmatched tail, which falls to the generic collector below.
- **The generic JSON-LD collector (`src/collect/generic.ts`, wired into
  `check` via `runGeneric` in `src/cli.ts`) handles `offers`, and unwraps
  `@graph`-wrapped nodes (common from WordPress/Yoast sites)**, but its
  coverage is not exhaustive — it does not attempt microdata, RDFa, or every
  schema.org type a commerce page might use. It is the fallback for the
  unmatched tail of hosts (the majority case, since per-host collectors
  above are still placeholders), not a general schema.org parser. A fetch
  failure here always reports `error`, never `empty` — see
  `tests/cli.test.ts`'s "generic collector fallback" tests.
- **Scraper Studio itself under-collects prose-embedded values.** The probe
  (`docs/probes/2026-08-17-scraper-studio.md`, Probe A) found that even an
  explicit "every price on the page, as a list" prompt missed a second Adult
  price that the live page states in a prose note rather than its pricing
  table. Collector prompts likely need explicit instruction to walk list
  items and inline text, not just tabular markup, and that tuning is
  per-collector work this hackathon window didn't reach.

## Conduct

Public data only — no login-protected, paywalled, personal, or otherwise
restricted sources. `api.viator.com` (21 URLs in the reference corpus) is an
authenticated partner API and is excluded from the corpus entirely
(`src/ingest/factpack.ts`). robots.txt is fetched once per host — through the
same `HostQueue` that paces every other request to that host, identified with
`claimrot/0.1 (+https://github.com/claimrot/claimrot)` (`ROBOTS_UA` in
`src/cli.ts`) — and checked before any claim on that host is checked; a claim
whose path is disallowed is skipped, never silently treated as removed
(`src/net/politeness.ts`'s `isAllowed`, tested in `tests/net/robots.test.ts`;
`docs/design.md` §10).

Per-host concurrency is 1, at roughly 0.8 requests/second
(`src/net/politeness.ts`'s `HostQueue`, 1250ms between requests to the same
host). This is not politeness theatre: 375 concurrent probes against a
partner's production host once caused a 90-minute outage — a real scar this
design (`docs/design.md` §10) carries forward. A monitor that watches 352
hosts and hits all of them at once is a DDoS with a cron attached. Parallelism
in claimrot is only ever *across* hosts — one host's queue never blocks
another's — never within one. This same rule governed how this README's own
example run touched the live `whalewatch.co.nz` host: one collector, one
request in flight at a time, issued serially.

## AI-assistance disclosure

This project was designed and implemented with Claude Code (Anthropic).
Claude Code wrote the design document, the engine, the collectors, the CLI,
the GitHub Action, the tests, and this README, under direction and review
from the author throughout. The author understands the design — the
three-outcome recheck, the anchor-not-value scoring, the heal-on-blindness
rule, and the honesty constraints on the corpus study above — and can explain
any part of it.
