<img src="docs/assets/logo.webp" alt="claimrot" width="300">

# claimrot

Re-checks the claims your docs cite against the pages they cite, and tells you
which ones stopped being true.

[![CI](https://github.com/claimrot/claimrot/actions/workflows/ci.yml/badge.svg)](https://github.com/claimrot/claimrot/actions/workflows/ci.yml)
· [Site](https://claimrot.github.io/claimrot/)
· [Architecture](docs/architecture.md)

## The problem

You cite a page. Months later that page changes a number. The link still
resolves, nothing 404s, no build breaks — and your documentation now states
something false with a citation attached to it.

Link rot has a name and tooling. This doesn't.

## What it looks like

```
$ claimrot report

DRIFTED  (confidence 1.00, checked 2026-08-17)
  published: Adult admission on the Ocean Cabin tour is NZ$170.
  source:    https://whalewatch.co.nz/…/whale-watch-tour/
  now:       "Adult" = 175
  why:       "Adult" now reads 175, expected 170
```

Real output, from a real page. More of it in [`examples/`](examples/).

## Use it

Node 22+. Only `ingest` needs a model at all, and it will use whichever of
these you already have — an API key, or a CLI you're logged into:

| `--backend` | Needs | Notes |
| --- | --- | --- |
| `claude-cli` | `claude`, logged in | Default. No API key. ~30s per claim. |
| `codex-cli` | `codex`, logged in | No API key. ~25s per claim. |
| `api` | `ANTHROPIC_API_KEY` | Fastest, metered, and the only one CI can use. |

Picked automatically in that order, or set it yourself with `--backend` /
`CLAIMROT_INGEST`. A logged-in CLI wins over `ANTHROPIC_API_KEY` on purpose:
that variable is exported in plenty of shells for unrelated reasons, and it
shouldn't quietly start billing you. `--backend api` opts in.

The CLI backends also unset `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` for the
child process, since both CLIs otherwise let an exported key override the login
you chose them for.

`check` and `report` need none of this.

```bash
git clone https://github.com/claimrot/claimrot
cd claimrot && npm install

# Reduce prose claims into testable assertions. Once per claim, then never again.
npm run cli -- ingest 'path/to/*.facts.json'

# Fetch each source, score candidates, heal when blind, record verdicts.
npm run cli -- check

# Print the receipts.
npm run cli -- report
```

## The idea

Most monitors compare a page to its last snapshot and answer *same* or
*changed*. That holds up until the checker goes blind — a redesign moves the
price, a selector stops matching — and then a two-answer system tells you the
operator deleted something they didn't.

claimrot has more than two answers.

- `HOLDS` — the source still says what you published.
- `DRIFTED` — it changed. Here's the old value, the new one, and the URL.
- `MOVED` — still true, but not where you cited it. Here's the new URL.
- `UNVERIFIABLE` — we couldn't read it, and we won't guess.

Finding nothing never produces a verdict. It asks Bright Data Scraper Studio to
repair the scraper, runs it again, and — if a working scraper still sees
nothing — looks for the value elsewhere on the same site before concluding
anything. Only when a healed scraper finds it nowhere does claimrot say
`REMOVED`. Self-healing isn't what makes this fast; it's what makes a negative
worth believing.

The other half is that an assertion stores *"whatever sits beside the label
Adult"*, not *"175"*. An operator's NZ$59 was once the adult fare and is now the
senior fare — the number is still on the page, so anything searching for the
value calls that claim healthy forever.

More in [docs/architecture.md](docs/architecture.md).

## In CI

```bash
npm run cli -- report --json > claimrot-verdicts.json
```

```yaml
- uses: claimrot/claimrot@v1
  with:
    verdicts: claimrot-verdicts.json
    confidence-floor: "0.75"
```

`UNVERIFIABLE` never fails a build. A check that goes red because our own
scraper broke gets turned off within a fortnight, and then it protects nobody.

## Limitations

- **No half-life figure is published anywhere in this repo.** Measuring how fast
  cited claims decay needs an ingest run over the full 2,572-claim corpus, which
  needs an API key this machine doesn't have. The four-claim example proves the
  mechanism works; it says nothing about a decay rate.
- **Checks run per claim, not per page.** A page cited by three claims is fetched
  three times — roughly 2.7× the requests the corpus needs. Fixing it means
  reworking the loop that per-host pacing is built around, so it waited.
- **Relocation only follows the site's own signals.** When a value vanishes,
  claimrot looks for it via links on the cited page and the host's
  `sitemap.xml`, on that host only, and stops after five candidates. A value
  that moved somewhere neither points to still reports as `REMOVED`.
- **The generic fallback can detect blindness but not repair it.** Healing needs
  a real Scraper Studio collector, so self-repair covers hosts you've
  provisioned one for; everything else degrades to `UNVERIFIABLE`.
- **The blob-label screen is structural, not semantic.** A genuine two-axis grid
  cell labelled "Adult Weekday" gets screened out when "Adult" and "Weekday" are
  both anchors. It fails toward `UNVERIFIABLE`, never toward a wrong verdict.
- **Three things are specified but unwired:** `anchor_path`, `expires_at`, and
  the `checks`/`candidates` tables. Listed in
  [docs/architecture.md](docs/architecture.md) so nobody finds them by surprise.
- The Action's bundle is committed at `dist/action/main.js` and must be rebuilt
  when `action/main.ts` changes. CI won't catch a stale one.

## Conduct

Public data only — nothing behind a login, paywall, or personal account.
`api.viator.com` is an authenticated partner API and is excluded outright.

One request in flight per host, about 0.8 per second, parallel across hosts and
never within one. `robots.txt` is fetched once per host through that same queue
and honoured before any claim on it is checked; a disallowed URL produces no
verdict rather than a guess. Every direct request identifies itself as
`claimrot/0.1 (+https://github.com/claimrot/claimrot)`.

That pacing isn't decoration. 375 concurrent probes against a partner's
production host once caused a 90-minute outage, and a monitor watching 352 hosts
at once is a DDoS with a cron attached.

## Built with

Designed and implemented with Claude Code (Anthropic), under review throughout.
Built for the Bright Data *Into the Scrape-Verse* hackathon, August 2026.

MIT
