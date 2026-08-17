# Architecture

How claimrot is put together, and why the pieces are split where they are.

If you only read one thing, read [The decision](#the-decision) — everything else
exists to serve it.

## The shape of it

```mermaid
flowchart TD
    A["fact packs<br/><i>(claim, source_url)</i>"] --> B[ingest]
    B -->|"one model call per claim,<br/>then never again"| C[(SQLite)]

    C --> D[check]
    D --> E{collector}
    E -->|host has one| F[Bright Data<br/>Scraper Studio]
    E -->|the long tail| G[generic<br/>schema.org JSON-LD]

    F --> H[candidates]
    G --> H
    H --> I[score against<br/>the stored anchor]
    I --> J{did anything<br/>clear?}

    J -->|yes| K[compare values]
    J -->|no — we went blind| L[heal the scraper]
    L --> E

    K --> C
    C --> M[report]
    M --> N[receipts]
    M --> O["--json → GitHub Action"]
```

## The decision

Everything hinges on separating two things that look identical from the outside:

- **the value changed** — that is a finding
- **we can no longer see the value** — that is a statement about our own eyesight

A checker that conflates them reports every site redesign as *"the operator
deleted this."* Its negatives become worthless, and within a fortnight nobody
reads its alerts.

So finding nothing never produces a verdict. It produces a repair attempt, and
only a *working* scraper that still finds nothing may say `REMOVED`.

| Extraction | Comparison | Verdict |
| --- | --- | --- |
| clean | matches | `HOLDS` |
| clean | differs | `DRIFTED` |
| clean | two readings, both defensible | `AMBIGUOUS` |
| nothing | — | heal, then re-run |
| nothing after a successful heal | — | `REMOVED` |
| heal failed or is awaiting approval | — | `UNVERIFIABLE` |

`src/engine/check.ts` is the only file allowed to reach those last three. A test
sweeps every combination of extraction failure and heal outcome and asserts that
none of them can produce `DRIFTED`.

## Anchors, not values

An assertion does not store *"175"*. It stores *"whatever sits beside the label
**Adult**, in the section **Ocean Cabin**"*.

The difference matters because of a real case: an operator's NZ$59 was the adult
fare and later became the senior fare. The number is still on the page. A checker
that searches for `59` finds it and reports the claim healthy indefinitely. A
checker that searches for `Adult` reads `65` and catches it immediately.

`src/resolve/score.ts` therefore never reads a candidate's value. It scores only
how well the candidate's *label and context* match the recorded anchor, and a
test asserts that two candidates differing only in value score identically.

## Modules

| Path | Job |
| --- | --- |
| `src/ingest/` | Read fact packs; reduce prose to assertions (the only model call) |
| `src/collect/` | Run collectors, map their output to candidates, screen blobs |
| `src/resolve/` | Score candidates against an anchor; turn them into a verdict |
| `src/engine/` | The three-branch decision, and when to check next |
| `src/report/` | Receipts for humans, JSON for CI |
| `src/net/` | Per-host rate limiting and robots.txt |
| `src/db/` | Schema, row mappers, shared statements |
| `action/` | The GitHub Action that fails a pull request |

Dependencies point one way: `resolve` never learns about collectors, `engine`
depends only on `resolve` and the shared types, `report` only touches the
database.

## Why the model is called once

Reducing *"Ocean Cabin is NZ$175 per adult"* into something testable needs
language understanding. Comparing `175` to `175` does not.

So the model runs once per claim at ingest and produces a structured assertion.
Every check afterwards is a fetch and a numeric comparison — no model call, no
per-check inference cost. That is what makes monitoring thousands of claims on a
schedule affordable rather than theoretical.

## Storage

One SQLite file.

```
documents ──< claims ──< assertions
                 │
                 └──< verdicts   (verdict, confidence, evidence_json)
```

Two timestamps on `claims` do different jobs and must not be merged:

- **`checked_at`** — when the *source* was last verified by whoever wrote the
  claim. Immutable after ingest. The half-life study measures against it.
- **`last_checked_at`** — when claimrot last looked. The scheduler owns it.

Collapsing these into one column makes every claim appear zero days old the
moment you run a check, which silently flattens the decay study to nothing.

## Being a good citizen

Third parties bear the cost of a monitor that runs on a schedule, so:

- one request in flight per host, roughly 0.8 per second, parallel *across* hosts
  only
- `robots.txt` fetched once per host through the same queue, wildcard group,
  longest-match `Allow`
- an identifying User-Agent with a contact URL on every direct request
- a disallowed URL produces **no verdict at all** rather than a fabricated one

The rate limit is not decoration. An earlier project put 375 concurrent probes on
a partner's production host and took it down for ninety minutes.

## Things that are specified but not wired

Written down so nobody has to discover them by reading source:

- `anchor_path` is never populated, so the DOM-path signal in scoring cannot
  fire. Scores renormalise over the signals that do exist.
- `expires_at` is never populated, so the expiry-aware scheduling — check the day
  before *and* the day after a self-declared expiry — is implemented, tested, and
  unreachable in production.
- The `checks` and `candidates` tables are created and never written. Evidence
  lives inline in `verdicts.evidence_json`.
