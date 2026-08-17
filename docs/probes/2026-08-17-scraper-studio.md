# Day-1 Scraper Studio probes

Spike, not implementation. Two design assumptions in `docs/design.md` belong to Bright
Data Scraper Studio's product, not ours. This probes both before Task 5 builds on them.

CLI: `@brightdata/cli` v0.3.5, invoked as `npx -p @brightdata/cli bdata ...` throughout.
Auth: already logged in (operator), balance $52.00 at start. One collector created and
reused across all three probes, per budget (max 3 collectors, none exceeded — used 1).

Target: `https://whalewatch.co.nz/your-experience/our-tours/whale-watch-tour/` — confirmed
HTTP 200 at probe time, publishes a current Adult price ($175, table) and a post-1-October
Adult price ($185, prose note) — the label-ambiguity case Probe A needed.
`https://whalewatch.co.nz/robots.txt` is `User-agent: *\nAllow: /`. All requests to the
target host were issued serially with pauses; no concurrent requests were made.

---

## Probe A — does a collector emit a labelled candidate array?

**Question:** does `fields.<name>` come back as an array of `{value, label, context, path}`
(spec §4.3), or does it flatten to one value per field?

**Command 1 — create:**

```
npx -p @brightdata/cli bdata scraper create \
  "https://whalewatch.co.nz/your-experience/our-tours/whale-watch-tour/" \
  "Every price on the page as a list. For each: numeric value, currency, the exact label text that governs it (e.g. Adult, Child), and the nearest enclosing heading." \
  --name claimrot-probe-a --json --pretty
```

Output (envelope after 28 poll attempts, ~2 min):

```json
{"collector_id":"c_msx2l16bsipcs0zz","name":"claimrot-probe-a","status":"done","completed_steps":["prepare_intent_analyzer","planner","collector_mainatiner","output_schema_generator","code_generator","input_schema_generator","preview_runner","preview_picker"],"view_url":"https://brightdata.com/cp/scrapers/c_msx2l16bsipcs0zz","created_at":"2026-08-17T10:07:19.859Z"}
```

**Command 2 — run:**

```
npx -p @brightdata/cli bdata scraper run c_msx2l16bsipcs0zz \
  "https://whalewatch.co.nz/your-experience/our-tours/whale-watch-tour/" \
  --json --pretty
```

Output (verbatim, untrimmed — this is the whole payload):

```json
[{"prices":[{"price_value":175,"currency":"NZD","label":"Adult","heading":"Ocean Cabin Pricing:"},{"price_value":60,"currency":"NZD","label":"Child (3yrs-15yrs)","heading":"Ocean Cabin Pricing:"}],"input":{"url":"https://whalewatch.co.nz/your-experience/our-tours/whale-watch-tour/"}}]
```

**Verdict: CONFIRMED, with a material caveat.**

The collector does emit an array, one entry per price, each carrying its own governing
label and a context string (`heading`). That is the shape spec §4.3 needs — it is not a
single flattened `{value}` per field.

But field names differ from the spec's `{value, label, context, path}`:

- `price_value` not `value`
- `label` — matches
- `heading` not `context` (semantically the same: nearest enclosing heading text)
- **no `path` field at all** — there is no DOM selector / XPath in the payload, so
  candidate re-verification by structural path (not just by label text) is not available
  from this envelope as returned. `studio.ts`'s adapter must map `price_value → value`,
  `heading → context`, and treat `path` as absent (`undefined`) unless a different prompt
  phrasing surfaces it — untested here, out of scope for this probe's budget.

**The bigger caveat:** this page was chosen specifically because it publishes a *second*
Adult price — "As of the 1st of October 2026, the Ocean Cabin Adult rate increases to
NZ$185.00" — inside a prose `<li>` note below the pricing table, not inside the table
itself. Confirmed directly against the live page's HTML (`curl`, same visit budget) before
running the collector. The collector's array contains only the two table rows ($175 Adult,
$60 Child) — it did **not** surface the $185 post-October Adult price as a second
candidate under the "Adult" label, or under any label.

This means the array *shape* holds, but array *completeness* does not: an AI-generated
Scraper Studio collector, even one explicitly prompted for "every price on the page as a
list," will still under-collect prices that sit in prose rather than in a structured
table/element. For Task 5, `fields.Adult` from this collector alone would show exactly one
candidate for this page today, not the two the ambiguity design assumes — the resolver's
multi-candidate branch (spec §4.2 "several candidates per field") would never fire on this
real page unless the extraction prompt (or a follow-up heal) is tuned to also walk list
items and inline text, not just tabular markup. This is a collector-authoring problem, not
a shape problem, but it directly affects whether Task 4/7's ambiguity path is exercised in
practice against this class of page.

---

## Probe B — does a heal fire when a run succeeds but returns NOTHING?

**Question:** does the engine's blindness branch (heal-on-empty, not heal-on-error) work
against the real CLI?

**Command 1 — run against a priceless page** (`privacy-policy/privacy-policy/`, same host,
robots-allowed, confirmed by direct fetch to carry no tour-price table — only the sitewide
footer teaser widget, which this collector's prompt does not match against):

```
npx -p @brightdata/cli bdata scraper run c_msx2l16bsipcs0zz \
  "https://whalewatch.co.nz/privacy-policy/privacy-policy/" --json --pretty
```

Output (verbatim, untrimmed):

```json
[{"prices":[],"input":{"url":"https://whalewatch.co.nz/privacy-policy/privacy-policy/"}}]
```

Exit code 0. No error, no non-zero status, no error field — a clean, successful run that
returns an empty array. This is exactly the "blindness, not error" case spec §4.5 exists
to distinguish.

**Command 2 — heal on a prompt describing the empty result** (not an actual thrown error):

```
npx -p @brightdata/cli bdata scraper heal c_msx2l16bsipcs0zz \
  "The scraper returns no price candidates for this page. It should extract every price with its governing label; verify it still finds the label 'Adult'." \
  --url "https://whalewatch.co.nz/privacy-policy/privacy-policy/" --json --pretty
```

Output (verbatim, untrimmed — after 55 poll attempts, ~2.5 min):

```json
{"collector_id":"c_msx2l16bsipcs0zz","status":"awaiting_approval","completed_steps":["planner","control_preview_runner","code_fixer","step_preview_runner","request_fulfillment_validator","step_advance"],"prompt":"The scraper returns no price candidates for this page. It should extract every price with its governing label; verify it still finds the label 'Adult'.","view_url":"https://brightdata.com/cp/scrapers/c_msx2l16bsipcs0zz","next_step":"bdata scraper approve c_msx2l16bsipcs0zz --url https://whalewatch.co.nz/privacy-policy/privacy-policy/","preview_result":[{"prices":[{"price_value":175,"currency":"NZD","label":"Adult","heading":"Ocean Cabin Pricing:"},{"price_value":60,"currency":"NZD","label":"Child (3yrs-15yrs)","heading":"Ocean Cabin Pricing:"}]}],"diff_summary":"proposed template has 1 step(s) — review at view_url"}
```

**Verdict: CONFIRMED.**

`heal` accepted a natural-language prompt describing an empty result — with no thrown
error, no non-2xx response, nothing but a legitimately empty array from a prior run — and
proceeded all the way to `status: "awaiting_approval"`. It did not reject the request, did
not demand an actual error condition, and did not itself re-verify that the described
"no candidates" state was real. (Note the CLI's own `--url` documentation held: `preview_result`
reflects the collector's original target page structure, not a fresh scrape of the
`--url` we passed — confirming `--url` is cosmetic to the heal call itself, exactly as
`--help` says: "Not sent to the heal call.")

This confirms the design assumption: heal-on-blindness (an empty-but-successful result)
works with a prompt built purely from the engine's own description of what went missing —
no synthetic error needs to be manufactured by `studio.ts`.

---

## Probe C — the two approval paths

**Question:** what does `--auto-approve` return vs. the separate `scraper approve`
command, and is `--auto-save` required for a healed template to persist?

**Path 1 — manual gate.** Approve the heal left `awaiting_approval` by Probe B, **without**
`--auto-save`:

```
npx -p @brightdata/cli bdata scraper approve c_msx2l16bsipcs0zz \
  --url "https://whalewatch.co.nz/privacy-policy/privacy-policy/" --json --pretty
```

Output (verbatim, untrimmed):

```json
{"collector_id":"c_msx2l16bsipcs0zz","status":"done","completed_steps":["planner","control_preview_runner","code_fixer","step_preview_runner","request_fulfillment_validator","step_advance","user_approval"],"prompt":"","view_url":"https://brightdata.com/cp/scrapers/c_msx2l16bsipcs0zz","next_step":"bdata scraper run c_msx2l16bsipcs0zz https://whalewatch.co.nz/privacy-policy/privacy-policy/"}
```

`status: "done"`. `completed_steps` ends at `"user_approval"`. **No `save_new_template`
step appears anywhere in this list.**

**Path 2 — unattended, `--auto-approve --auto-save` together** (new heal cycle, same
collector, reused per budget):

```
npx -p @brightdata/cli bdata scraper heal c_msx2l16bsipcs0zz \
  "Confirm the scraper still extracts the Adult and Child prices with their labels and the 'Ocean Cabin Pricing' heading on the whale watch tour page." \
  --auto-approve --auto-save --json --pretty
```

Output (verbatim, untrimmed — after 8 poll attempts):

```json
{"collector_id":"c_msx2l16bsipcs0zz","status":"done","completed_steps":["planner","control_preview_runner","step_advance","user_approval","save_new_template"],"prompt":"Confirm the scraper still extracts the Adult and Child prices with their labels and the 'Ocean Cabin Pricing' heading on the whale watch tour page.","view_url":"https://brightdata.com/cp/scrapers/c_msx2l16bsipcs0zz","next_step":"bdata scraper run c_msx2l16bsipcs0zz <url>"}
```

`status: "done"`. `completed_steps` ends at **`"save_new_template"`** — present this time,
absent in Path 1.

**Verdict: CONFIRMED — `--auto-save` is required, and its absence is silent.**

Both paths return `status: "done"`, and both look, at the top level, like success. The
*only* observable difference in the two envelopes is the presence or absence of the
`save_new_template` entry in `completed_steps`. There is no error, no warning, no distinct
status value, and no field that says "not saved" — a caller that checks `status === "done"`
and stops there cannot tell these two outcomes apart.

This confirms the brief's stated risk exactly: if an unattended heal passes
`--auto-approve` without `--auto-save`, the job completes successfully, returns `status:
"done"`, and the fix is **silently discarded** — never promoted to the default template.
`studio.ts`'s `healCollector` must always pass both flags together for unattended use, and
its parser must treat `"save_new_template" in completed_steps` as the actual persistence
signal, not `status`.

---

## Exact JSON envelope shapes (verbatim field names, for Task 5's parser)

**`scraper create` envelope:**

```
{ collector_id, name, status, completed_steps: string[], view_url, created_at }
```

**`scraper run` envelope** (note: top-level is an ARRAY, one object per URL scraped):

```
[ { <field_name>: [ { price_value, currency, label, heading }, ... ], input: { url } } ]
```

Field names inside each candidate are whatever the create-time description asked for
(`price_value`, `currency`, `label`, `heading` in this probe) — **not** the spec's
`{value, label, context, path}` names. No `path` (DOM selector) was present in any run
observed. `context` must be mapped from whatever context-like field the prompt elicited
(`heading` here).

**`scraper heal` / `scraper approve` envelope:**

```
{
  collector_id,
  status,                 // "awaiting_approval" | "done"
  completed_steps: string[],   // presence of "save_new_template" = actually persisted
  prompt,
  view_url,
  next_step,               // ready-to-run next CLI command, as a string
  preview_result?,          // present on awaiting_approval; NOT a fresh scrape of --url
  diff_summary?              // present on awaiting_approval
}
```

`--url` on both `heal` and `approve` is cosmetic only — woven into `next_step`'s text, not
sent to the underlying call, and does not affect `preview_result`.

---

## Consequences for Task 5 (per the plan's Step 5 guidance)

- **Probe A is CONFIRMED for shape** — `studio.ts`'s `CollectorRecord` contract from the
  plan stands: candidates arrive as an array with a label and a context string per entry.
  No client-side re-architecture into `src/collect/generic.ts` is needed for the *shape*
  concern the plan flagged as the REFUTED branch.
  However, field-name mapping is now a hard requirement, not an assumption:
  `price_value → value`, `heading → context`, and `path` must be treated as always-absent
  from this CLI version — any resolver logic that requires `path` for corroboration
  (spec §4.2, mentioned as the weakest/dead signal in Task 3's ledger — corroboration is
  already hardcoded 0 in `scoreCandidate`) has no data to consume even if implemented,
  since this collector never returns one. That downstream gap (already flagged as a
  deferred Task 3 minor) is now confirmed structurally unfixable from this data source
  alone.
  Separately — not a shape defect but a completeness one — the AI-authored extraction
  under-collects prose-embedded prices even when explicitly asked for "every price... as a
  list." Task 5 and whoever authors production collector prompts should not assume a
  single `scraper create` call surfaces every candidate; the create prompt likely needs
  explicit instruction to also walk list items / inline text, and probably a fact-pack
  ingest step (Task's `ingest/normalize.ts`) that flags claims sourced from prose so
  reviewers know a collector may need prompt-tuning per claim, not just per page.

- **Probe B is CONFIRMED** — the plan's non-REFUTED path stands: `studio.ts` can invoke
  `healCollector` directly from the engine's own blindness description (no synthetic error
  needs manufacturing) and the CLI will run the heal to completion. The engine's
  three-branch design (spec §4.5) needs no change.

- **Probe C is CONFIRMED, and this is the operationally sharpest finding of the spike.**
  `healCollector`'s unattended code path (used by the scheduler / GitHub Action, Tasks 10
  and 13) **must** pass `--auto-approve` and `--auto-save` together, always. `studio.ts`
  must never call heal with `--auto-approve` alone in an unattended context — doing so
  produces a `status: "done"` response indistinguishable at the status level from a real
  save, while the fix is discarded. The adapter's return type (`HealResult`, per Task 5's
  cross-task row in the ledger) should surface a `saved: boolean` field derived from
  `completed_steps.includes("save_new_template")`, not from `status`, so Task 7's
  `EngineDeps.heal` consumer and any receipt/report code (Task 12) can tell a persisted fix
  from a silently dropped one.

## Credits / collectors used

One collector created (`c_msx2l16bsipcs0zz`), reused across all three probes as
instructed. Budget ceiling was 3 collectors; 1 was used. Balance not re-checked after the
spike (out of scope; `bdata` calls that read balance were not part of the brief).
