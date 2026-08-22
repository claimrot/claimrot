<img src="docs/assets/logo.webp" alt="claimrot" width="300">

# claimrot

Know when a fact you depend on stops being true—even when its link still works.

[![CI](https://github.com/claimrot/claimrot/actions/workflows/ci.yml/badge.svg)](https://github.com/claimrot/claimrot/actions/workflows/ci.yml)
· [Website](https://claimrot.github.io/claimrot/)
· [Live dashboard](https://claimrot.github.io/claimrot/demo/)
· [Architecture](docs/architecture.md)

## What it does

A link checker tells you when a page disappears. claimrot tells you when the
fact on that page changes.

It can:

- re-check claims quoted in documentation or content;
- monitor structured fields such as product names, descriptions, and prices;
- keep the history and evidence in a local SQLite database;
- show results in the terminal, JSON, or a local HTML dashboard.

If a scraper stops finding a value after a page redesign, claimrot does not
pretend the value was removed. It tries to repair the scraper first and reports
`UNVERIFIABLE` when it cannot reach a trustworthy conclusion.

## Install

Requires Node.js 22 or newer.

```bash
git clone https://github.com/claimrot/claimrot.git
cd claimrot
npm install
```

## Check a published claim

Create a fact pack such as `pricing.facts.json`:

```json
{
  "slug": "pricing-page",
  "as_of": "2026-08-22",
  "facts": [
    {
      "id": "adult-price",
      "claim": "Adult admission is NZ$175.",
      "source_url": "https://example.com/pricing",
      "volatile": true
    }
  ]
}
```

Then ingest, check, and report:

```bash
npm run cli -- ingest '*.facts.json'
npm run cli -- check
npm run cli -- report
```

`ingest` uses a model once to turn prose into a testable assertion. It can use
an existing Claude or Codex CLI login, or an Anthropic API key. Later checks do
not need a model.

## Monitor fields on a page

Describe the fields you want in a schema:

```json
{
  "fields": {
    "name": { "type": "string", "description": "Product name" },
    "price": { "type": "money", "description": "Advertised price" }
  },
  "intervalDays": 7
}
```

Create the monitor and read its latest result:

```bash
npm run cli -- --db claimrot.db extract https://example.com/product \
  --schema examples/product.schema.json --id example-product

npm run cli -- --db claimrot.db get example-product --json
```

Run every monitor that is due, or open the local dashboard:

```bash
npm run cli -- --db claimrot.db run
npm run cli -- view claimrot.db
```

`run` is designed for cron, a job queue, or a scheduled workflow; it is not a
background daemon.

## Verdicts

| Verdict | Meaning |
| --- | --- |
| `HOLDS` | The source still supports the claim. |
| `DRIFTED` | The value changed. |
| `MOVED` | The claim is still true, but the source moved. |
| `REMOVED` | A repaired scraper still could not find the value. |
| `AMBIGUOUS` / `CONFLICT` | The evidence needs review. |
| `UNVERIFIABLE` | claimrot could not check safely, so it did not guess. |

Every verdict includes the source, evidence, confidence, and reason.

## Scraper Studio

For configured hosts, claimrot runs Bright Data Scraper Studio collectors and
asks Scraper Studio to heal them when extraction goes blind. Other public pages
use a schema.org/Open Graph fallback, which can detect extraction failure but
cannot repair itself.

## CI

Export verdicts and use the included GitHub Action to stop confident drift from
being merged:

```bash
npm run --silent cli -- report --json > claimrot-verdicts.json
```

```yaml
- uses: claimrot/claimrot@v1
  with:
    verdicts: claimrot-verdicts.json
    confidence-floor: "0.75"
```

`UNVERIFIABLE` never fails a build.

## Responsible use

claimrot reads public pages only. It honours `robots.txt`, identifies itself,
and limits each host to one request at a time at roughly 0.8 requests per
second.

See [Architecture](docs/architecture.md) for implementation details and known
limitations.

MIT
