import type Database from "better-sqlite3";
import type { Resolution, Verdict } from "../model/types.js";
import {
  currentClaimRows, isVerdict, readEvidence, type ReportClaimRow,
} from "./current.js";

type Db = Database.Database;
type DisplayVerdict = Verdict | "UNCHECKED" | "UNKNOWN";

interface HistoryEvent {
  claimId: string;
  assertionKey: string;
  verdict: string;
  createdAt: string;
}

interface HealthPoint {
  at: string;
  percent: number;
}

const ACTION_VERDICTS = new Set<Verdict>(["DRIFTED", "MOVED", "REMOVED"]);
const REVIEW_VERDICTS = new Set<Verdict>(["AMBIGUOUS", "CONFLICT", "UNVERIFIABLE"]);
const SEVERITY: Record<Verdict, number> = {
  DRIFTED: 1,
  REMOVED: 2,
  MOVED: 3,
  CONFLICT: 4,
  AMBIGUOUS: 5,
  UNVERIFIABLE: 6,
  HOLDS: 7,
};

const VERDICT_COPY: Record<DisplayVerdict, { label: string; note: string }> = {
  HOLDS: { label: "Holds", note: "The cited claim still matches its source." },
  DRIFTED: { label: "Drifted", note: "The source now says something different." },
  MOVED: { label: "Moved", note: "The claim still holds, but its citation moved." },
  REMOVED: { label: "Removed", note: "A healed scraper could no longer find the claim." },
  AMBIGUOUS: { label: "Ambiguous", note: "More than one reading remains plausible." },
  CONFLICT: { label: "Conflict", note: "The available evidence disagrees." },
  UNVERIFIABLE: { label: "Unverifiable", note: "The source could not be read reliably." },
  UNCHECKED: { label: "Not checked", note: "This claim does not have a recorded check yet." },
  UNKNOWN: { label: "Unknown status", note: "This stored verdict is not recognized by this version of claimrot." },
};

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function sourceLabel(value: string): string {
  try {
    const url = new URL(value);
    const path = url.pathname === "/" ? "" : url.pathname;
    return url.host ? `${url.host}${path}` : value;
  } catch {
    return value;
  }
}

function renderSourceLink(url: string, label?: string): string {
  const safe = safeHttpUrl(url);
  const text = escapeHtml(label ?? sourceLabel(url));
  if (!safe) return `<span class="source-link source-link--plain">${text}</span>`;
  return `<a class="source-link" href="${escapeHtml(safe)}" target="_blank" rel="noreferrer">${text}<span aria-hidden="true">↗</span></a>`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || "Unknown";
  return new Intl.DateTimeFormat("en", {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    timeZone: "UTC", timeZoneName: "short",
  }).format(date);
}

function formatShortDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" }).format(date);
}

function formatRelative(value: string | null, now: Date): string {
  if (!value) return "Never";
  const date = new Date(value);
  const difference = now.getTime() - date.getTime();
  if (Number.isNaN(date.getTime()) || difference < 0) return formatDate(value);
  const minutes = Math.floor(difference / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  return formatShortDate(value);
}

function formatValue(evidence: Partial<Resolution>): string {
  if (!evidence.chosen) return "No reliable current value";
  const value = evidence.chosen.value ?? evidence.chosen.valueText ?? "—";
  const unit = evidence.chosen.unit ? ` ${evidence.chosen.unit}` : "";
  const label = evidence.chosen.label ? `“${evidence.chosen.label}”` : "Current source";
  return `${label} = ${value}${unit}`;
}

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function displayVerdict(row: ReportClaimRow): DisplayVerdict {
  return isVerdict(row.verdict) ? row.verdict : row.verdict === null ? "UNCHECKED" : "UNKNOWN";
}

function groupFor(row: ReportClaimRow): "action" | "review" | "holds" | "unchecked" {
  const verdict = displayVerdict(row);
  if (verdict === "UNCHECKED") return "unchecked";
  if (isVerdict(row.verdict) && ACTION_VERDICTS.has(row.verdict)) return "action";
  if (row.verdict === "HOLDS") return "holds";
  return "review";
}

function rowReason(row: ReportClaimRow, evidence: Partial<Resolution>): string {
  const verdict = displayVerdict(row);
  if (verdict === "UNCHECKED") {
    return row.status === "untestable"
      ? "No testable assertions were produced for this claim during ingest."
      : "Run claimrot check to record its first result.";
  }
  if (verdict === "UNKNOWN") {
    return `Stored verdict “${row.verdict}” is not recognized; inspect the database or upgrade claimrot.`;
  }
  return typeof evidence.reason === "string" && evidence.reason.trim()
    ? evidence.reason
    : "No explanation was recorded for this check.";
}

function claimDomId(row: ReportClaimRow): string {
  return `claim-${encodeURIComponent(row.claimId)}`;
}

function renderBadge(row: ReportClaimRow): string {
  const verdict = displayVerdict(row);
  return `<span class="status status--${verdict.toLowerCase()}"><span aria-hidden="true"></span>${escapeHtml(VERDICT_COPY[verdict].label)}</span>`;
}

function renderClaimRow(row: ReportClaimRow, now: Date): string {
  const verdict = displayVerdict(row);
  const evidence = readEvidence(row.evidence);
  const reason = rowReason(row, evidence);
  const confidence = Math.round(Math.max(0, Math.min(1, row.confidence ?? 0)) * 100);
  const confidenceText = verdict === "UNCHECKED" || verdict === "UNKNOWN" || verdict === "UNVERIFIABLE"
    ? "Confidence n/a"
    : `${confidence}% confidence`;
  const foundAt = typeof evidence.foundAt === "string" ? evidence.foundAt : null;
  const searchable = [row.claim, row.url, verdict, reason, row.documentTitle ?? ""]
    .join(" ").toLowerCase();

  return `<details class="claim-row" id="${escapeHtml(claimDomId(row))}" data-group="${groupFor(row)}" data-search="${escapeHtml(searchable)}">
    <summary class="claim-grid">
      <span class="claim-cell claim-name" data-label="Claim">
        ${row.documentTitle ? `<small>${escapeHtml(row.documentTitle)}</small>` : ""}
        <strong>${escapeHtml(row.claim)}</strong>
      </span>
      <span class="claim-cell" data-label="Source">${renderSourceLink(row.url)}</span>
      <span class="claim-cell" data-label="Status">${renderBadge(row)}</span>
      <span class="claim-cell claim-time" data-label="Last checked">${escapeHtml(formatRelative(row.ranAt, now))}<span aria-hidden="true">›</span></span>
    </summary>
    <div class="claim-receipt">
      <div><span>Current reading</span><strong>${escapeHtml(formatValue(evidence))}</strong></div>
      <div><span>Why</span><strong>${escapeHtml(reason)}</strong></div>
      <div><span>Check details</span><strong>${escapeHtml(confidenceText)} · ${plural(row.assertionCount, "assertion")}</strong></div>
${foundAt ? `      <div><span>Citation found at</span><strong>${renderSourceLink(foundAt)}</strong></div>` : ""}
${row.repeatAmbiguous ? `      <p class="escalation">Ambiguous twice running · human review required</p>` : ""}
    </div>
  </details>`;
}

function renderAttentionRow(row: ReportClaimRow, now: Date): string {
  const verdict = displayVerdict(row);
  const evidence = readEvidence(row.evidence);
  return `<a class="attention-row" href="#${escapeHtml(claimDomId(row))}">
    <span class="attention-icon status--${verdict.toLowerCase()}" aria-hidden="true">${groupFor(row) === "action" ? "!" : "◉"}</span>
    <span><strong>${escapeHtml(row.claim)}</strong><small>${escapeHtml(rowReason(row, evidence))} · ${escapeHtml(formatRelative(row.ranAt, now))}</small></span>
    ${renderBadge(row)}<span class="arrow" aria-hidden="true">›</span>
  </a>`;
}

function readHealthSeries(db: Db): HealthPoint[] {
  const events = db.prepare(
    `SELECT claim_id AS claimId, COALESCE(assertion_id, '__legacy__') AS assertionKey,
            verdict, created_at AS createdAt
     FROM verdicts ORDER BY created_at, rowid`,
  ).all() as HistoryEvent[];
  const assertionsByClaim = new Map<string, Map<string, Verdict>>();
  const points: HealthPoint[] = [];

  for (const event of events) {
    if (!isVerdict(event.verdict)) continue;
    const claim = assertionsByClaim.get(event.claimId) ?? new Map<string, Verdict>();
    claim.set(event.assertionKey, event.verdict);
    assertionsByClaim.set(event.claimId, claim);

    const current = [...assertionsByClaim.values()].map((assertions) =>
      [...assertions.values()].sort((a, b) => SEVERITY[a] - SEVERITY[b])[0],
    );
    const valid = current.filter((verdict) => verdict === "HOLDS" || verdict === "MOVED").length;
    const percent = current.length ? Math.round((valid / current.length) * 100) : 0;
    const last = points.at(-1);
    if (last?.at === event.createdAt) last.percent = percent;
    else points.push({ at: event.createdAt, percent });
  }
  return points;
}

function renderHealthChart(points: HealthPoint[]): string {
  if (points.length === 0) {
    return `<div class="chart-empty"><strong>No check history yet</strong><span>Run claimrot check to start the health timeline.</span></div>`;
  }
  const width = 620;
  const left = 42;
  const right = 18;
  const top = 16;
  const bottom = 142;
  const x = (index: number) => points.length === 1
    ? left
    : left + (index / (points.length - 1)) * (width - left - right);
  const y = (percent: number) => top + ((100 - percent) / 100) * (bottom - top);
  let path = `M ${x(0).toFixed(1)} ${y(points[0].percent).toFixed(1)}`;
  for (let index = 1; index < points.length; index++) {
    path += ` H ${x(index).toFixed(1)} V ${y(points[index].percent).toFixed(1)}`;
  }
  const last = points.at(-1)!;
  return `<div class="chart-wrap">
    <svg class="health-chart" viewBox="0 0 ${width} 174" role="img" aria-label="Claim health changed from ${points[0].percent} to ${last.percent} percent across ${plural(points.length, "recorded check")}">
      ${[100, 75, 50, 25, 0].map((tick) => `<line x1="${left}" y1="${y(tick)}" x2="${width - right}" y2="${y(tick)}"/><text x="0" y="${y(tick) + 4}">${tick}%</text>`).join("")}
      <path d="${path}"/>
      <circle cx="${x(0)}" cy="${y(points[0].percent)}" r="3"/>
      <circle cx="${x(points.length - 1)}" cy="${y(last.percent)}" r="4"/>
      <text class="chart-value" x="${Math.max(left, x(points.length - 1) - 38)}" y="${Math.max(14, y(last.percent) - 10)}">${last.percent}%</text>
      <text class="chart-date" x="${left}" y="168">${escapeHtml(formatShortDate(points[0].at))}</text>
      <text class="chart-date" x="${width - right}" y="168" text-anchor="end">${escapeHtml(formatShortDate(last.at))}</text>
    </svg>
    <p><span><i class="fresh"></i>Currently valid</span><span><i class="drifted"></i>Needs attention</span></p>
  </div>`;
}

function renderLatestReceipt(row: ReportClaimRow | undefined, now: Date): string {
  if (!row?.ranAt) {
    return `<div class="panel-empty"><strong>No receipt yet</strong><span>The first completed check will appear here.</span></div>`;
  }
  const relative = escapeHtml(formatRelative(row.ranAt, now));
  return `<ol class="receipt-steps">
    <li><span aria-hidden="true">↓</span><div><strong>Source captured</strong><small>${relative}</small></div></li>
    <li><span aria-hidden="true">⚖</span><div><strong>Claim compared</strong><small>${relative}</small></div></li>
    <li><span aria-hidden="true">▤</span><div><strong>Evidence saved</strong><small>${relative}</small></div></li>
  </ol>`;
}

function brandMarkup(): string {
  return `<span class="brand">
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9.5 14.5 14.5 9.5"/>
      <path d="M11 6.5 12.8 4.7a4.6 4.6 0 0 1 6.5 6.5L17.5 13"/>
      <path d="M13 17.5l-1.8 1.8a4.6 4.6 0 0 1-6.5-6.5L6.5 11"/>
    </svg>claimrot
  </span>`;
}

/** A self-contained app-style report backed entirely by the local SQLite database. */
export function renderDashboard(db: Db, generatedAt = new Date()): string {
  const rows = currentClaimRows(db);
  const checkedRows = rows.filter((row) => isVerdict(row.verdict));
  const valid = rows.filter((row) => row.verdict === "HOLDS" || row.verdict === "MOVED").length;
  const actionRows = rows.filter((row) => isVerdict(row.verdict) && ACTION_VERDICTS.has(row.verdict));
  const reviewRows = rows.filter((row) => isVerdict(row.verdict)
    ? REVIEW_VERDICTS.has(row.verdict)
    : row.verdict !== null);
  const attentionRows = [...actionRows, ...reviewRows].slice(0, 4);
  const health = checkedRows.length ? Math.round((valid / checkedRows.length) * 100) : null;
  const latest = [...checkedRows].sort((a, b) => (b.ranAt ?? "").localeCompare(a.ranAt ?? ""))[0];
  const healthPoints = readHealthSeries(db);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
  <title>Claim health · claimrot</title>
  <style>
    :root {
      --paper:#f7f3ec; --surface:#fffdfa; --surface-soft:#f3eee6; --ink:#1d1c19;
      --muted:#696258; --line:#ddd4c7; --line-strong:#aa9e8e; --rust:#bd3f18;
      --rust-soft:#fae6d8; --green:#17623d; --green-soft:#e3eee6;
      --violet:#68508e; --violet-soft:#eee8f4; --shadow:0 14px 42px rgb(52 38 23 / 7%);
      --sans:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      --mono:"SFMono-Regular",Consolas,"Liberation Mono",monospace;
    }
    *{box-sizing:border-box} html{background:var(--paper);color:var(--ink);font-family:var(--sans);scroll-behavior:smooth}
    body{margin:0;min-width:20rem} button,input{font:inherit} a{color:inherit}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
    :focus-visible{outline:2px solid var(--rust);outline-offset:3px}.app{display:grid;grid-template-columns:14.25rem minmax(0,1fr);min-height:100vh}
    .sidebar{position:sticky;top:0;height:100vh;padding:1.9rem 1rem;border-right:1px solid var(--line);background:rgb(255 253 250 / 72%);display:flex;flex-direction:column}
    .brand{display:inline-flex;align-items:center;gap:.7rem;font-size:1.28rem;font-weight:780;letter-spacing:-.03em}.brand svg{width:1.8rem;height:1.8rem;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round}
    .side-nav{display:grid;gap:.35rem;margin-top:2.5rem}.side-nav a{display:flex;align-items:center;gap:.75rem;min-height:3rem;padding:.7rem .8rem;border-left:2px solid transparent;text-decoration:none;color:var(--muted)}
    .side-nav a:hover{color:var(--ink);background:var(--surface-soft)}.side-nav a:first-child{color:var(--ink);border-left-color:var(--rust);background:var(--surface-soft)}.side-nav span{width:1.25rem;text-align:center;font-family:var(--mono)}
    .side-note{margin:auto 0 0;padding:.9rem;color:var(--muted);border-top:1px solid var(--line);font:.68rem/1.6 var(--mono);text-transform:uppercase;letter-spacing:.06em}
    main{min-width:0;padding:2rem clamp(1rem,3vw,3rem) 4rem}.topbar{display:flex;align-items:flex-start;justify-content:space-between;gap:1.5rem;margin:0 auto 1.5rem;max-width:87rem}
    h1{margin:0;font-size:clamp(2rem,4vw,3rem);line-height:1;letter-spacing:-.055em}.subtitle{margin:.45rem 0 0;color:var(--muted);font-size:1rem}.top-actions{display:flex;align-items:center;gap:1.2rem;color:var(--muted);font-size:.86rem}.top-actions time{white-space:nowrap}
    .primary{display:inline-flex;align-items:center;justify-content:center;min-height:2.9rem;padding:.7rem 1.1rem;color:white;background:var(--rust);border:1px solid var(--rust);text-decoration:none;font-weight:700}.primary:hover{background:#983315}
    .content{max-width:87rem;margin:0 auto}.metrics{display:grid;grid-template-columns:2.2fr repeat(3,1fr);gap:.9rem}.metric{min-height:9.5rem;padding:1.25rem;border:1px solid var(--line);background:var(--surface);box-shadow:var(--shadow);display:flex;align-items:center;gap:1.25rem}
    .metric strong{display:block;font-size:2.5rem;line-height:1;letter-spacing:-.05em}.metric small{display:block;margin-top:.55rem;font:700 .68rem/1.2 var(--mono);text-transform:uppercase;letter-spacing:.08em}.metric-icon{width:3.4rem;height:3.4rem;display:grid;place-items:center;border-radius:50%;font-size:1.45rem}.metric-icon.green{color:var(--green);background:var(--green-soft)}.metric-icon.rust{color:var(--rust);background:var(--rust-soft)}.metric-icon.violet{color:var(--violet);background:var(--violet-soft)}
    .health-ring{--health:0%;width:6.6rem;height:6.6rem;flex:0 0 auto;border-radius:50%;display:grid;place-items:center;background:conic-gradient(var(--green) var(--health),var(--rust) 0);position:relative}.health-ring--empty{background:var(--line-strong)}.health-ring::after{content:"";position:absolute;inset:.75rem;border-radius:50%;background:var(--surface)}.health-ring span{position:relative;z-index:1;font:700 .68rem/1.2 var(--mono);text-transform:uppercase;color:var(--muted)}
    .dashboard-grid{display:grid;grid-template-columns:minmax(0,1.7fr) minmax(19rem,1fr);gap:.9rem;margin-top:.9rem}.panel{border:1px solid var(--line);background:var(--surface);box-shadow:var(--shadow);min-width:0}.panel-head{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:1rem 1.15rem;border-bottom:1px solid var(--line)}.panel-head h2{margin:0;font-size:1.05rem}.panel-head span{color:var(--muted);font:.68rem/1.3 var(--mono);text-transform:uppercase;letter-spacing:.06em}.chart-panel{min-height:22rem}.chart-wrap{padding:1rem 1.2rem .6rem}.health-chart{display:block;width:100%;height:auto}.health-chart line{stroke:var(--line);stroke-dasharray:3 4}.health-chart text{fill:var(--muted);font:10px var(--mono)}.health-chart path{fill:none;stroke:var(--green);stroke-width:3;stroke-linejoin:round}.health-chart circle{fill:var(--green)}.health-chart .chart-value{fill:var(--green);font-weight:700;font-size:13px}.chart-wrap p{display:flex;gap:1rem;margin:.25rem 0 0;color:var(--muted);font-size:.78rem}.chart-wrap p span{display:flex;align-items:center;gap:.4rem}.chart-wrap i{width:.55rem;height:.55rem;border-radius:50%}.chart-wrap .fresh{background:var(--green)}.chart-wrap .drifted{background:var(--rust)}
    .chart-empty,.panel-empty{min-height:15rem;display:grid;place-content:center;text-align:center;padding:2rem}.chart-empty span,.panel-empty span{color:var(--muted);margin-top:.4rem}.attention-list{padding:.7rem;display:grid;gap:.55rem}.attention-row{display:grid;grid-template-columns:auto minmax(0,1fr) auto auto;align-items:center;gap:.75rem;padding:.75rem;border:1px solid var(--line);text-decoration:none}.attention-row:hover{border-color:var(--line-strong);background:var(--surface-soft)}.attention-row>span:nth-child(2){min-width:0}.attention-row strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.88rem}.attention-row small{display:block;margin-top:.25rem;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.attention-icon{width:2.3rem;height:2.3rem;display:grid;place-items:center;border-radius:.45rem;font-weight:800}.attention-icon.status--drifted,.attention-icon.status--removed,.attention-icon.status--moved{color:var(--rust);background:var(--rust-soft)}.attention-icon.status--ambiguous,.attention-icon.status--conflict,.attention-icon.status--unverifiable,.attention-icon.status--unknown{color:var(--violet);background:var(--violet-soft)}.arrow{color:var(--muted);font-size:1.4rem}
    .status{display:inline-flex;align-items:center;gap:.4rem;font:700 .66rem/1 var(--mono);text-transform:uppercase;letter-spacing:.05em;white-space:nowrap}.status>span{width:.46rem;height:.46rem;border-radius:50%;background:currentColor}.status--holds{color:var(--green)}.status--drifted,.status--removed{color:var(--rust)}.status--moved{color:#9a5a00}.status--ambiguous,.status--conflict,.status--unverifiable,.status--unknown{color:var(--violet)}.status--unchecked{color:var(--muted)}
    .receipt-steps{list-style:none;margin:0;padding:.75rem 1rem 1rem;display:grid;gap:.4rem}.receipt-steps li{display:flex;align-items:center;gap:.75rem;padding:.55rem 0}.receipt-steps li>span{width:2.6rem;height:2.6rem;display:grid;place-items:center;border-radius:.4rem;background:var(--surface-soft);font-size:1.1rem}.receipt-steps strong,.receipt-steps small{display:block}.receipt-steps strong{font-size:.86rem}.receipt-steps small{margin-top:.2rem;color:var(--muted)}
    .claims-panel{margin-top:0}.claims-toolbar{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:.8rem 1rem;border-bottom:1px solid var(--line)}.filters{display:flex;flex-wrap:wrap;gap:.35rem}.filter{min-height:2.75rem;padding:.5rem .75rem;border:1px solid transparent;background:transparent;color:var(--muted);cursor:pointer}.filter:hover{border-color:var(--line)}.filter[aria-pressed="true"]{color:white;background:var(--ink)}.search{width:min(18rem,38vw);min-height:2.75rem;padding:.55rem .7rem;border:1px solid var(--line-strong);background:var(--surface)}
    .results-meta{display:flex;justify-content:space-between;gap:1rem;margin:0;padding:.65rem 1rem;color:var(--muted);border-bottom:1px solid var(--line);font:.67rem/1.4 var(--mono);text-transform:uppercase;letter-spacing:.06em}.claim-grid{display:grid;grid-template-columns:minmax(16rem,1.65fr) minmax(13rem,1.35fr) minmax(7rem,.65fr) minmax(7rem,.6fr);align-items:center;gap:1rem}.claim-columns{padding:.7rem 1rem;color:var(--muted);background:var(--surface-soft);font:.67rem/1.2 var(--mono);text-transform:uppercase;letter-spacing:.06em}.claim-row{border-bottom:1px solid var(--line)}.claim-row[hidden]{display:none}.claim-row summary{list-style:none;cursor:pointer;padding:.9rem 1rem}.claim-row summary::-webkit-details-marker{display:none}.claim-row summary:hover{background:var(--surface-soft)}.claim-cell{min-width:0;font-size:.82rem}.claim-cell small{display:block;margin-bottom:.25rem;color:var(--muted);font:.62rem/1.2 var(--mono);text-transform:uppercase;letter-spacing:.05em}.claim-cell strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.claim-cell .source-link{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.claim-time{display:flex;justify-content:space-between;align-items:center;color:var(--muted)}
    .source-link{display:inline-flex;gap:.35rem;color:var(--ink);text-underline-offset:.2rem}.source-link--plain{color:var(--muted)}.claim-receipt{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.75rem;padding:1rem;background:var(--surface-soft);border-top:1px solid var(--line)}.claim-receipt>div{padding:.8rem;border-left:2px solid var(--line-strong);background:var(--surface)}.claim-receipt span{display:block;margin-bottom:.35rem;color:var(--muted);font:.63rem/1.2 var(--mono);text-transform:uppercase;letter-spacing:.06em}.claim-receipt strong{font-size:.8rem;line-height:1.45;overflow-wrap:anywhere}.escalation{grid-column:1/-1;margin:0;padding:.65rem;color:var(--violet);border:1px solid var(--violet);font:700 .66rem/1.3 var(--mono);text-transform:uppercase;letter-spacing:.06em}.empty{padding:3rem 1rem;text-align:center}.empty strong,.empty span{display:block}.empty span{margin-top:.4rem;color:var(--muted)}
    .page-footer{max-width:87rem;margin:1.2rem auto 0;padding:1rem 0;color:var(--muted);font:.67rem/1.5 var(--mono)}.page-footer a{color:var(--ink)}
    @media(max-width:68rem){.metrics{grid-template-columns:repeat(2,1fr)}.dashboard-grid{grid-template-columns:1fr}.claims-panel{grid-column:auto}.claim-grid{grid-template-columns:minmax(14rem,1.5fr) minmax(11rem,1fr) minmax(7rem,.6fr) minmax(7rem,.6fr)}}
    @media(max-width:50rem){.app{display:block}.sidebar{position:static;width:auto;height:auto;padding:1rem;border-right:0;border-bottom:1px solid var(--line);display:block}.side-nav{display:flex;overflow-x:auto;margin-top:1rem}.side-nav a{white-space:nowrap}.side-note{display:none}main{padding-top:1.3rem}.topbar{align-items:flex-start}.top-actions time{display:none}.claim-columns{display:none}.claim-grid{grid-template-columns:1fr 1fr}.claim-cell::before{content:attr(data-label);display:block;margin-bottom:.25rem;color:var(--muted);font:.6rem/1.2 var(--mono);text-transform:uppercase}.claim-name{grid-column:1/-1}.claim-receipt{grid-template-columns:1fr 1fr}}
    @media(max-width:34rem){.metrics{grid-template-columns:1fr}.metric{min-height:7.5rem}.topbar{display:block}.top-actions{margin-top:1rem}.claims-toolbar{align-items:stretch;flex-direction:column}.search{width:100%}.claim-grid,.claim-receipt{grid-template-columns:1fr}.attention-row{grid-template-columns:auto minmax(0,1fr) auto}.attention-row .status{display:none}.claim-name{grid-column:auto}.health-ring{width:5.5rem;height:5.5rem}.sidebar .brand{margin-left:.35rem}}
    @media print{.sidebar,.primary,.claims-toolbar{display:none}.app{display:block}main{padding:1rem}.panel,.metric{box-shadow:none}.claim-row{break-inside:avoid}}
  </style>
</head>
<body>
  <div class="app">
    <aside class="sidebar">
      ${brandMarkup()}
      <nav class="side-nav" aria-label="Report sections">
        <a href="#overview"><span aria-hidden="true">▦</span>Overview</a>
        <a href="#claims"><span aria-hidden="true">▤</span>Claims</a>
        <a href="#attention"><span aria-hidden="true">!</span>Attention</a>
        <a href="#activity"><span aria-hidden="true">◷</span>Activity</a>
        <a href="https://claimrot.github.io/claimrot/"><span aria-hidden="true">↗</span>About</a>
      </nav>
      <p class="side-note">Static local report<br>No data uploaded</p>
    </aside>
    <main>
      <header class="topbar" id="overview">
        <div><h1>Claim health</h1><p class="subtitle">Are the claims you publish still valid? Checked against their sources.</p></div>
        <div class="top-actions"><time datetime="${escapeHtml(generatedAt.toISOString())}">◷ Last checked ${escapeHtml(formatRelative(latest?.ranAt ?? null, generatedAt))}</time><a class="primary" href="https://claimrot.github.io/claimrot/#start">＋ Monitor a claim</a></div>
      </header>
      <div class="content">
        <section class="metrics" aria-label="Report summary">
          <div class="metric"><div class="health-ring${health === null ? " health-ring--empty" : ""}" style="--health:${health ?? 0}%"><span>${checkedRows.length ? "checked" : "no data"}</span></div><div><strong>${health === null ? "—" : `${health}%`}</strong><small>${health === null ? "No checks yet" : "Currently valid"}</small></div></div>
          <div class="metric"><span class="metric-icon green" aria-hidden="true">↗</span><div><strong>${rows.length}</strong><small>Monitored</small></div></div>
          <div class="metric"><span class="metric-icon rust" aria-hidden="true">!</span><div><strong>${actionRows.length}</strong><small>Need action</small></div></div>
          <div class="metric"><span class="metric-icon violet" aria-hidden="true">◉</span><div><strong>${reviewRows.length}</strong><small>Need review</small></div></div>
        </section>
        <div class="dashboard-grid">
          <section class="panel chart-panel" id="activity"><div class="panel-head"><h2>Health over time</h2><span>${plural(healthPoints.length, "checkpoint")}</span></div>${renderHealthChart(healthPoints)}</section>
          <section class="panel" id="attention"><div class="panel-head"><h2>Needs attention</h2><span>${plural(actionRows.length + reviewRows.length, "claim")}</span></div>${attentionRows.length ? `<div class="attention-list">${attentionRows.map((row) => renderAttentionRow(row, generatedAt)).join("")}</div>` : `<div class="panel-empty"><strong>Nothing needs attention</strong><span>Every checked claim currently holds.</span></div>`}</section>
          <section class="panel claims-panel" id="claims">
            <div class="panel-head"><h2>Claims</h2><span>Expand a row for its receipt</span></div>
            <div class="claims-toolbar">
              <div class="filters" role="group" aria-label="Filter claims">
                <button class="filter" type="button" data-filter="all" aria-pressed="true">All</button>
                <button class="filter" type="button" data-filter="action" aria-pressed="false">Needs action</button>
                <button class="filter" type="button" data-filter="review" aria-pressed="false">Needs review</button>
                <button class="filter" type="button" data-filter="holds" aria-pressed="false">Holds</button>
                <button class="filter" type="button" data-filter="unchecked" aria-pressed="false">Not checked</button>
              </div>
              <label><span class="sr-only">Search claims</span><input class="search" type="search" placeholder="Search claims or sources…" autocomplete="off"></label>
            </div>
            <p class="results-meta"><span class="result-count" role="status" aria-live="polite">${plural(rows.length, "result")}</span><span>Current state per claim</span></p>
            <div class="claim-columns claim-grid" aria-hidden="true"><span>Claim</span><span>Source</span><span>Status</span><span>Last checked</span></div>
            <div class="claim-list">${rows.map((row) => renderClaimRow(row, generatedAt)).join("")}</div>
            <div class="empty" ${rows.length ? "hidden" : ""}><strong>${rows.length ? "No matching claims" : "No claims ingested yet"}</strong><span>${rows.length ? "Try another filter or search term." : "Run claimrot ingest, then claimrot check to build this report."}</span></div>
          </section>
          <section class="panel"><div class="panel-head"><h2>Latest receipt</h2><span>${latest?.ranAt ? escapeHtml(formatShortDate(latest.ranAt)) : "Waiting for a check"}</span></div>${renderLatestReceipt(latest, generatedAt)}</section>
        </div>
        <footer class="page-footer">Generated locally by claimrot. No report data was uploaded. · <a href="https://claimrot.github.io/claimrot/">About claimrot</a> · <a href="https://github.com/claimrot/claimrot">Source</a></footer>
      </div>
    </main>
  </div>
  <script>
    (() => {
      const filters = [...document.querySelectorAll('.filter')];
      const rows = [...document.querySelectorAll('.claim-row')];
      const search = document.querySelector('.search');
      const count = document.querySelector('.result-count');
      const empty = document.querySelector('.empty');
      let active = 'all';
      const update = () => {
        const term = search.value.trim().toLowerCase();
        let visible = 0;
        for (const row of rows) {
          const matchesGroup = active === 'all' || row.dataset.group === active;
          const matchesTerm = !term || row.dataset.search.includes(term);
          row.hidden = !(matchesGroup && matchesTerm);
          if (!row.hidden) visible++;
        }
        count.textContent = visible + ' result' + (visible === 1 ? '' : 's');
        empty.hidden = visible !== 0;
      };
      for (const button of filters) button.addEventListener('click', () => {
        active = button.dataset.filter;
        for (const candidate of filters) candidate.setAttribute('aria-pressed', String(candidate === button));
        update();
      });
      search.addEventListener('input', update);
    })();
  </script>
</body>
</html>`;
}
