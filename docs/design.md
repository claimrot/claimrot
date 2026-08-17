# claimrot — design

**Status:** approved design, pre-implementation
**Date:** 2026-08-17
**Repo:** https://github.com/claimrot/claimrot
**Context:** Bright Data "Into the Scrape-Verse" hackathon, 17–23 August 2026

---

## 1. The problem

Link rot has a name and tooling. **Claim rot** has neither.

Every system that cites a source produces assertions that quietly stop being true.
A RAG index, an LLM-generated article, a docs page citing an external API's rate
limits, a comparison site, a compliance team watching a policy page — in all of
them the citation still resolves. The link is not dead. The *claim behind it* no
longer matches the page.

Nobody monitors this, and the reason is the hackathon's own premise:

> "You write a scraper, it works, and a week later the site changes its layout and
> everything breaks quietly."

Your sources are a heterogeneous long tail. A scraper per source rots faster than
the facts do, so the monitoring costs more than the staleness does, so nobody
monitors. Self-healing extraction is what changes that arithmetic.

## 2. What claimrot is

Give it `(claim, source_url)` pairs. It tells you which claims stopped being true —
and, critically, **never confuses "I can't see it any more" with "it's gone."**

### 2.1 The distinction the whole system exists to enforce

A recheck has three outcomes, not two:

| | |
|---|---|
| Extracted cleanly, value matches | still true — silent |
| Extracted cleanly, value differs | **drift** — report with receipts |
| Extracted nothing | **unknown, and specifically not drift** |

The third case is ambiguous by construction: either the layout moved and our
collector is blind, or the fact really was removed. They are indistinguishable from
outside. So blindness triggers a **heal**, and only a *healed* collector that still
finds nothing is allowed to say "removed."

This is not academic. In a prior pipeline we shipped a confidently false refutation
into two published documents because a literal search for `$115` missed markup that
split the `$` from its digits, and the system read "I could not find it" as "it is
not there." A monitor without self-healing makes that mistake on **every** site
redesign. Every layout change reports as a removal, the false-positive rate goes
through the roof, and nobody trusts the alerts by week two.

**Self-healing is not what makes the monitor fast. It is what makes the monitor's
negatives believable.**

### 2.2 Why this is not a page-diff tool

changedetection.io, Visualping and similar tools diff **pages**. On a live
commercial page that is constant noise — a banner, a countdown, a rotating
testimonial, a tracking parameter. We diff **claims**. Page churn is irrelevant;
the only question is whether *this specific assertion* still holds.

Claim-level monitoring is the original move here, and it is only tractable because
self-healing keeps the extractors alive across the tail.

## 3. Non-goals

- Not a general crawler or archiver.
- Not a page-change notifier.
- Not a fact-checker: claimrot verifies a claim against **the source it cites**, and
  has no opinion on whether that source is right.
- Not a scraper-authoring IDE. Collectors come out of Bright Data Scraper Studio.

## 4. Core design

### 4.1 The insight: abstract once, verify forever

A prose claim is not comparable to a scraped page. Something must reduce
"Ocean Cabin is NZ$175 per adult and NZ$60 per child (3–15)" to something a machine
can test.

claimrot does that reduction **once, at ingest** — never per check:

```json
{ "field": "adult_price", "op": "eq", "value": 175, "unit": "NZD" }
```

Supported operators: `eq`, `approx` (tolerance-bounded), `range`, `contains`,
`exists`. A claim that reduces to no testable operator is stored as
`untestable` and excluded from checking rather than guessed at.

After ingest, every recheck is a deterministic comparison against a structured
record. **Zero model calls per check, forever.** The model cost is paid once per
claim; monitoring is a fraction of a cent per check thereafter.

This is what makes the economics real rather than rhetorical. The prior pipeline
this corpus came from spends ~400,000 tokens re-verifying one document. claimrot
re-verifies the same claims for the cost of an HTTP fetch and a numeric comparison.

### 4.2 The governing rule: anchor on the label, verify the value

**Never search for the value.** Search for the thing that *governs* the value, then
check what it now says.

The scar: an operator's NZ$59 was the adult fare, and became the *senior* fare. The
number is still on the page. A checker asking "is 59 still there?" answers yes, and
the stale claim survives indefinitely. A checker asking "what does *Adult* say now?"
catches it immediately.

So an assertion stores more than `{field, value, unit}`. It stores an **anchor**:

- `anchor_label` — the governing label text (`"Adult"`, `"Ocean Cabin"`, `"Adult (16+)"`)
- `anchor_context` — enclosing heading / table caption / section
- `anchor_path` — normalized DOM path, recorded at ingest

Path is the weakest signal and is never used alone — it is exactly what a redesign
destroys. Label and context carry the identity.

### 4.3 Collectors emit candidates, not values

A page routinely contains several plausible matches for one field: adult, child,
senior, group, a struck-through old price, a "from $X" teaser, a related product.
Any collector that silently returns one of them is guessing, and a monitor that
guesses is worse than no monitor.

So the collector contract is candidate-oriented:

```json
{
  "url": "https://example.com/tours/ocean-cabin",
  "fetched_at": "2026-08-17T09:14:02Z",
  "collector_version": "c_abc123@4",
  "page_signature": "sha256:…",
  "fields": {
    "adult_price": [
      {"value":185,"unit":"NZD","label":"Adult","context":"Ocean Cabin · from 1 Oct 2026","path":"…"},
      {"value":175,"unit":"NZD","label":"Adult","context":"Ocean Cabin · to 30 Sep 2026","path":"…"},
      {"value":60, "unit":"NZD","label":"Child (3–15)","context":"Ocean Cabin","path":"…"}
    ]
  }
}
```

The example is real: the operator publishes both the current price and the
post-1-October price on the same page, both labelled "Adult".

### 4.4 Scoring and resolution

Each candidate is scored on agreement across independent signals:

```
score = 0.40·label_similarity      // to anchor_label
      + 0.25·context_similarity    // to anchor_context
      + 0.15·corroboration         // JSON-LD / second source agrees
      + 0.10·unit_match
      + 0.10·path_stability        // vs anchor_path, weakest signal
```

- A candidate **clears** at `score ≥ 0.75`.
- The top candidate must beat the runner-up by `≥ 0.15`, *unless* their values agree.

Resolution has four outcomes:

| Situation | Verdict |
|---|---|
| One candidate clears, value matches assertion | `HOLDS` |
| One candidate clears, value differs | `DRIFTED` |
| Two or more clear and their values disagree | `AMBIGUOUS` — never reported as drift |
| None clears | fall through to the blindness branch (§4.5) |

`AMBIGUOUS` is a first-class result, not an error. It is the honest answer when the
page genuinely supports two readings.

### 4.5 The check engine

```
record = collector.run(url)

record has fields for this assertion?
├── yes → resolve candidates (§4.4)
│         ├── one clears, matches   → HOLDS
│         ├── one clears, differs   → DRIFTED
│         └── ambiguous             → AMBIGUOUS
│
└── no  → heal(collector, anchored on url)        ← Scraper Studio
          ├── heal ok, re-run finds it  → resolve as above
          ├── heal ok, still nothing    → REMOVED       (trustworthy negative)
          └── heal fails                → UNVERIFIABLE  (never reported as drift)
```

**Heal fires on blindness, never on change.** A changed value is a finding; a
missing value is a question about our own eyesight.

### 4.6 Multiple sources for one claim

A claim may carry a primary source plus optional corroborating sources — an
operator page, a booking calendar, a JSON-LD block. Agreement raises confidence.
Disagreement is its own verdict, `CONFLICT`.

This is also drawn from experience: two sibling fact packs once disagreed about the
same operator's price and both documents published anyway.

### 4.7 Verdict set

`HOLDS` · `DRIFTED` · `AMBIGUOUS` · `CONFLICT` · `REMOVED` · `UNVERIFIABLE`

Every verdict carries its confidence score and the evidence that produced it —
candidate list, matched snippet, collector version, fetch timestamp.

## 5. Scheduling

- Claim declares its own expiry (`expires_at`) → check at `expires_at − 1d` and
  `expires_at + 1d`. Some claims announce their death: *"valid to 30 September 2026;
  the adult rate rises to NZ$185 from 1 October."* Those are predictable drift.
- `volatile: true` → every 7 days.
- `volatile: false` → every 90 days.
- `UNVERIFIABLE` → exponential backoff 1d → 3d → 9d, capped at 30d.
- `AMBIGUOUS` → recheck next cycle; escalate after two consecutive.

Priority within a cycle is by **blast radius**: how many published documents cite
the claim.

## 6. Data model (SQLite)

```
documents (id, uri, title)
sources   (id, url, host, collector_id, robots_ok, last_fetch_at)
claims    (id, document_id, text, source_id, ingested_at, checked_at,
           volatile, expires_at, status)
assertions(id, claim_id, field, op, value_num, value_text, unit,
           anchor_label, anchor_context, anchor_path)
checks    (id, claim_id, run_at, collector_version, status,
           raw_snippet_ref, latency_ms)
candidates(id, check_id, field, value_num, value_text, unit,
           label, context, path, score)
verdicts  (id, check_id, claim_id, verdict, confidence, evidence_json)
```

Fetches are deduplicated **per distinct URL**, not per claim — in the reference
corpus that is 942 URLs carrying 2,572 claims, a mean of 2.7 claims per fetch.

**Not yet implemented.** `src/cli.ts`'s `check` command iterates one row per
*assertion* (via a JOIN over `assertions`/`claims`) and runs its own collector
call per row — there is no per-URL grouping or cache in that loop. So today's
actual fetch count is close to the assertion count, not the distinct-URL
count: roughly **2.7× the collector calls, requests and Bright Data spend**
this section's own numbers imply. This is the top open follow-up (see
README's Limitations). It was deliberately not fixed in the final pre-submission
pass: restructuring the per-row check loop this close to the deadline, with
the concurrency and per-host politeness code already wired around it
(`src/net/politeness.ts`'s `HostQueue`), was judged too invasive to risk.

## 7. Collectors and the tail

Collectors are bound to **host families** by URL pattern, not to individual claims:

- `*.fareharbor.com/embeds/book/*` — booking calendars
- `www.doc.govt.nz/*` — public-land alerts and closures
- `www.realnz.com/*`, `whalewatch.co.nz/*`, `www.bungy.co.nz/*` — operator pricing
- **generic** — schema.org JSON-LD / Open Graph / microdata fallback, which alone
  covers a substantial share of commerce pages

The busiest host in the corpus is `www.viator.com` (86 distinct URLs), which is
known to refuse plain fetches — it needs real rendering and referer-carrying
navigation. That makes it an honest test of collector robustness rather than a
convenience case, and it is handled by Scraper Studio's rendering rather than a
naive fetch.

Six to seven collectors for the reference corpus. The 352-host tail is the
*argument for self-healing*, not the build: a registry maps `source_url → collector`,
unmatched hosts fall to the generic collector, and the generic collector is the one
that heals most often.

## 8. Surfaces

### 8.1 CLI

```
claimrot ingest  <file.json|dir>   # normalize prose claims → assertions
claimrot check   [--due|--all]     # run the engine
claimrot report  [--verdict …]     # drift receipts
claimrot study                     # corpus half-life analysis
```

### 8.2 GitHub Action

A CI check that fails a pull request when a claim cited in your docs has drifted.
Configured by a `claimrot.yml` manifest; annotates the PR with the receipt.

Two deliberate behaviours:

- A **confidence floor** is configurable. A noisy check gets disabled in week two.
- `UNVERIFIABLE` **never fails the build.** That is the entire thesis, applied.

## 9. The corpus study

The reference corpus is 44 fact packs: **2,572 atomic claims, 1,724 marked volatile,
942 distinct source URLs, 352 distinct hosts**, 46 of which appear exactly once.
Every claim carries `source_url` and `checked_at`.

Running claimrot over it produces a *finding*, not just a demo: **the measured
half-life of a published fact** — what fraction of cited claims stop being true after
N days, broken down by source type.

**Bounded honestly:** the corpus `checked_at` dates span 2026-07-28 to 2026-08-08, so
the study can only measure 9–20 day decay. It cannot support a claim about 6-month
decay, and the write-up must not imply one.

## 10. Conduct, ethics, legal

- **Public data only.** No login-protected, paywalled, personal or restricted
  sources. `api.viator.com` (21 URLs in the corpus) is an authenticated partner API
  and is excluded.
- **robots.txt respected.**
- **Per-host concurrency of 1, ~0.8 req/s.** Not politeness theatre: 375 concurrent
  probes once took a partner's production host down for 90 minutes. A monitor that
  hammers 352 hosts is a DDoS with a cron. Parallelism is *across* hosts only.
- Identifying User-Agent with a contact URL.

## 11. Testing

- **Golden fixtures**: saved HTML of a page before and after a redesign, proving the
  blindness branch fires and that heal recovers.
- **Resolution unit tests**: the adult/child/senior/struck-through cases, and the
  label-migration case (value present, under a different label) which must produce
  `DRIFTED`, not `HOLDS`.
- **Scoring tests**: threshold and margin behaviour, including the deliberate
  `AMBIGUOUS` case of two same-labelled prices.
- **Never-drift-on-failure**: property test asserting no extraction failure can ever
  produce `DRIFTED`.

## 12. Demo

1. The problem, in 30 seconds, using the organisers' own framing.
2. Ingest 2,572 real claims.
3. Run the monitor → drift receipts and the half-life finding.
4. **Break a page we control**, on camera → collector returns empty → Scraper Studio
   heal envelope → approve → re-run → correct verdict. The money shot is never
   gambled on a third-party site behaving.
5. The CI check: a PR fails because a cited claim drifted.

## 13. Stack

TypeScript + Node, SQLite for state, a thin CLI. Chosen over Rust because the
Scraper Studio CLI is Node/`npx`, the GitHub Action is trivial in Node, and a judge
can read the whole thing in one sitting.

## 14. Risks

| Risk | Mitigation |
|---|---|
| Scraper Studio may not emit candidate **arrays** with labels as §4.3 requires | Validate on day 1, before anything is built on it. Fallback: collector returns the raw block and candidate extraction happens client-side. |
| Heal may require an actual error, not an empty result, to trigger | Day-1 probe. Fallback: synthesise a failure signal when a required field returns empty. |
| Corpus drift may be thin at 9–20 days | Controlled fixture carries the demo; self-declared expiries and the oldest wave carry the study. Do not depend on natural drift for the money shot. |
| Full-corpus run too slow under rate limits | Measured: 942 URLs, busiest host 86 URLs ≈ 1.8 min serial, hosts run in parallel. Not a risk. |

## 15. Timeline

| Day | |
|---|---|
| Mon 17 | Repo, engine skeleton, ingest + normalizer, **one collector end to end**, day-1 risk probes |
| Tue 18 | Collectors + registry + generic fallback; scheduler |
| Wed 19 | Heal branch wired to Scraper Studio; six-verdict resolution |
| Thu 20 | Full-corpus run; half-life study; drift receipts |
| Fri 21 | GitHub Action; README incl. AI-use disclosure |
| Sat 22 | Demo video |
| Sun 23 | Submit |

## 16. Submission checklist

- [ ] Public repository (not verified by Task 14 — repo visibility is outside this task's scope)
- [x] README explaining the problem, the workflow, and **how Scraper Studio is central**
- [x] Example structured output committed (`examples/output.json`, a genuine run — see README's Example output section for exactly what it did and did not exercise)
- [ ] Demo video
- [x] AI-assistance disclosure (required by the rules)
- [x] Public-data-only statement

## 17. Open questions

None blocking. Two to settle during build:

1. Exact scoring weights in §4.4 are a starting point, to be tuned against the
   golden fixtures rather than asserted.
2. Whether `CONFLICT` (§4.6) ships in the hackathon window or is specified only —
   it depends on how many corpus claims actually carry multiple sources.
