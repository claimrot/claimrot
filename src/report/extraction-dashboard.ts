import type { MonitorSnapshot } from "../extract/types.js";

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatDate(value: string | null): string {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en", {
    month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(date);
}

function displayValue(value: string | number | null, unit: string | null): string {
  if (value === null) return "No value";
  return `${String(value)}${unit ? ` ${unit}` : ""}`;
}

function sourceInfo(value: string): { host: string; href: string | null } {
  try {
    const url = new URL(value);
    return {
      host: url.hostname || "Invalid source",
      href: url.protocol === "http:" || url.protocol === "https:" ? url.href : null,
    };
  } catch {
    return { host: "Invalid source", href: null };
  }
}

function brandMarkup(): string {
  return `<span class="brand"><svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M9.5 14.5 14.5 9.5"/><path d="M11 6.5 12.8 4.7a4.6 4.6 0 0 1 6.5 6.5L17.5 13"/>
    <path d="M13 17.5l-1.8 1.8a4.6 4.6 0 0 1-6.5-6.5L6.5 11"/>
  </svg>claimrot</span>`;
}

function monitorCard(snapshot: MonitorSnapshot): string {
  const { monitor, latestRun, fields } = snapshot;
  const source = sourceInfo(monitor.sourceUrl);
  const status = latestRun?.status ?? "NOT_RUN";
  const values = Object.entries(monitor.definition.fields).map(([name, definition]) => {
    const field = fields[name];
    return `<div class="field">
      <span><strong>${escapeHtml(name)}</strong><small>${escapeHtml(definition.description)}</small></span>
      <span class="field-value">${escapeHtml(displayValue(field?.value ?? null, field?.unit ?? null))}</span>
      <span class="field-status field-status--${escapeHtml((field?.status ?? "MISSING").toLowerCase())}">${escapeHtml(field?.status ?? "Not scraped")}</span>
    </div>`;
  }).join("");
  const heal = latestRun?.healStatus && latestRun.healStatus !== "NOT_NEEDED"
    ? `<span class="heal">Heal: ${escapeHtml(latestRun.healStatus)}</span>` : "";
  const history = snapshot.recentRuns.slice(0, 5).map((run) =>
    `<li><span>${escapeHtml(formatDate(run.completedAt ?? run.startedAt))}</span><strong>${escapeHtml(run.status)}</strong>${run.dryRun ? "<em>Test</em>" : ""}${run.healStatus !== "NOT_NEEDED" ? `<em>Heal ${escapeHtml(run.healStatus)}</em>` : ""}</li>`).join("");
  return `<article class="monitor" id="monitor-${escapeHtml(encodeURIComponent(monitor.id))}">
    <header>
      <div><p class="monitor-id">${escapeHtml(monitor.id)}</p><h2>${escapeHtml(source.host)}</h2>
      ${source.href ? `<a href="${escapeHtml(source.href)}" target="_blank" rel="noreferrer">${escapeHtml(monitor.sourceUrl)} ↗</a>` : `<span>${escapeHtml(monitor.sourceUrl)}</span>`}</div>
      <span class="run-status run-status--${escapeHtml(status.toLowerCase())}">${escapeHtml(status.replaceAll("_", " "))}</span>
    </header>
    <div class="monitor-meta"><span>Last scraped <strong>${escapeHtml(formatDate(latestRun?.completedAt ?? null))}</strong></span><span>Next run <strong>${escapeHtml(formatDate(monitor.nextRunAt))}</strong></span><span>Collector <strong>${escapeHtml(monitor.collectorId)}</strong></span>${heal}</div>
    <div class="fields">${values}</div>
    ${latestRun?.error ? `<p class="run-error">${escapeHtml(latestRun.error)}</p>` : ""}
    ${history ? `<details class="history"><summary>Run history · ${snapshot.recentRuns.length}</summary><ol>${history}</ol></details>` : ""}
    <footer><button type="button" data-action="run" data-id="${escapeHtml(monitor.id)}">Run now</button><button class="secondary" type="button" data-action="test" data-id="${escapeHtml(monitor.id)}">Test extraction</button><output aria-live="polite"></output></footer>
  </article>`;
}

export function renderExtractionDashboard(
  snapshots: MonitorSnapshot[],
  token: string,
  databasePath: string,
): string {
  const completed = snapshots.filter((snapshot) => snapshot.latestRun?.status === "SUCCEEDED").length;
  const attention = snapshots.filter((snapshot) => snapshot.latestRun
    && snapshot.latestRun.status !== "SUCCEEDED").length;
  const valueCount = snapshots.reduce((total, snapshot) => total
    + Object.values(snapshot.fields).filter((field) => field.status === "OK").length, 0);
  const cards = snapshots.length
    ? snapshots.map(monitorCard).join("")
    : `<section class="empty"><strong>No extraction monitors yet</strong><p>Create one with <code>claimrot extract &lt;url&gt; --schema product.schema.json</code>, then reload this page.</p></section>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'">
<title>Extraction monitors · claimrot</title><style>
:root{--paper:#f6f2eb;--surface:#fffdfa;--soft:#f0eae0;--ink:#1d1c19;--muted:#696258;--line:#d9d0c4;--rust:#bd3f18;--green:#17623d;--violet:#68508e;--mono:ui-monospace,SFMono-Regular,Consolas,monospace;--sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}*{box-sizing:border-box}html{background:var(--paper);color:var(--ink);font-family:var(--sans)}body{margin:0;min-width:20rem}a{color:inherit;text-underline-offset:.2rem}:focus-visible{outline:2px solid var(--rust);outline-offset:3px}.shell{max-width:88rem;margin:auto;padding:1.5rem clamp(1rem,4vw,3rem) 4rem}.top{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding-bottom:1.4rem;border-bottom:1px solid var(--line)}.brand{display:inline-flex;align-items:center;gap:.65rem;font-size:1.3rem;font-weight:800}.brand svg{width:1.8rem;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round}.local{color:var(--muted);font:700 .67rem var(--mono);text-transform:uppercase}.hero{display:flex;justify-content:space-between;gap:2rem;align-items:end;padding:2.5rem 0 1.5rem}.hero h1{margin:0;font-size:clamp(2.4rem,5vw,4.5rem);letter-spacing:-.055em;line-height:.95}.hero p{max-width:35rem;margin:.8rem 0 0;color:var(--muted)}.db{padding:.7rem .9rem;border:1px solid var(--line);background:var(--surface);font:.7rem var(--mono);overflow-wrap:anywhere}.metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:.75rem;margin-bottom:.75rem}.metric{padding:1rem 1.2rem;border:1px solid var(--line);background:var(--surface)}.metric strong{display:block;font-size:2rem}.metric span{color:var(--muted);font:700 .68rem var(--mono);text-transform:uppercase}.monitors{display:grid;gap:.75rem}.monitor{border:1px solid var(--line);background:var(--surface);box-shadow:0 12px 34px rgb(45 32 18 / 5%)}.monitor>header{display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;padding:1.1rem 1.2rem;border-bottom:1px solid var(--line)}.monitor-id{margin:0 0 .3rem;color:var(--rust);font:700 .65rem var(--mono);text-transform:uppercase}.monitor h2{margin:0;font-size:1.35rem}.monitor header a{display:block;max-width:60vw;margin-top:.35rem;color:var(--muted);font-size:.8rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.run-status{padding:.45rem .6rem;border:1px solid currentColor;font:700 .65rem var(--mono);text-transform:uppercase}.run-status--succeeded{color:var(--green)}.run-status--partial,.run-status--failed,.run-status--blocked{color:var(--rust)}.run-status--not_run{color:var(--muted)}.monitor-meta{display:flex;flex-wrap:wrap;gap:.65rem 1.4rem;padding:.75rem 1.2rem;color:var(--muted);background:var(--soft);font:.7rem var(--mono)}.monitor-meta strong{color:var(--ink)}.heal{color:var(--violet)}.fields{padding:0 1.2rem}.field{display:grid;grid-template-columns:minmax(12rem,1fr) minmax(10rem,1fr) 8rem;gap:1rem;align-items:center;padding:1rem 0;border-bottom:1px solid var(--line)}.field span:first-child strong,.field span:first-child small{display:block}.field span:first-child small{margin-top:.25rem;color:var(--muted)}.field-value{font-weight:750;overflow-wrap:anywhere}.field-status{font:700 .65rem var(--mono);text-align:right;text-transform:uppercase}.field-status--ok{color:var(--green)}.field-status--ambiguous,.field-status--missing,.field-status--error{color:var(--rust)}.run-error{margin:1rem 1.2rem 0;padding:.75rem;color:var(--rust);border:1px solid var(--rust);font-size:.8rem}.monitor footer{display:flex;align-items:center;gap:.6rem;padding:1rem 1.2rem}.monitor button{min-height:2.6rem;padding:.6rem .9rem;color:white;background:var(--rust);border:1px solid var(--rust);font:700 .8rem var(--sans);cursor:pointer}.monitor button.secondary{color:var(--ink);background:transparent;border-color:var(--ink)}.monitor button:disabled{opacity:.55;cursor:wait}.monitor output{margin-left:.5rem;color:var(--muted);font-size:.75rem}.empty{padding:3rem;text-align:center;border:1px solid var(--line);background:var(--surface)}code{font-family:var(--mono)}@media(max-width:42rem){.hero{display:block}.db{margin-top:1rem}.metrics{grid-template-columns:1fr}.field{grid-template-columns:1fr}.field-status{text-align:left}.monitor header a{max-width:70vw}.monitor footer{align-items:stretch;flex-direction:column}.monitor output{margin:0}.monitor button{width:100%}}
.history{margin:1rem 1.2rem 0;border:1px solid var(--line);font-size:.75rem}.history summary{padding:.7rem;cursor:pointer;font:700 .68rem var(--mono);text-transform:uppercase}.history ol{list-style:none;margin:0;padding:0 .7rem .6rem}.history li{display:flex;gap:.8rem;align-items:center;padding:.45rem 0;border-top:1px solid var(--line)}.history li span{color:var(--muted)}.history li em{padding:.2rem .35rem;color:var(--violet);border:1px solid currentColor;font:normal 700 .6rem var(--mono);text-transform:uppercase}.monitor output{overflow-wrap:anywhere}
</style></head><body><main class="shell"><header class="top">${brandMarkup()}<span class="local">Local operational view</span></header>
<section class="hero"><div><h1>Extraction monitors</h1><p>Structured values, scrape history, and self-healing outcomes stored in your local claimrot database.</p></div><div class="db">${escapeHtml(databasePath)}</div></section>
<section class="metrics" aria-label="Monitor summary"><div class="metric"><strong>${snapshots.length}</strong><span>Monitors</span></div><div class="metric"><strong>${completed}</strong><span>Healthy</span></div><div class="metric"><strong>${attention}</strong><span>Need attention</span></div></section>
<p class="local">${valueCount} current values · Actions run in this local process</p><section class="monitors">${cards}</section></main>
<script>(()=>{const token=${JSON.stringify(token)};for(const button of document.querySelectorAll('button[data-action]'))button.addEventListener('click',async()=>{const card=button.closest('.monitor');const output=card.querySelector('output');const buttons=card.querySelectorAll('button');for(const item of buttons)item.disabled=true;output.textContent=button.dataset.action==='test'?'Testing…':'Running…';try{const response=await fetch('/api/'+button.dataset.action+'/'+encodeURIComponent(button.dataset.id),{method:'POST',headers:{'x-claimrot-token':token}});const result=await response.json();if(!response.ok)throw new Error(result.error||'Request failed');const values=Object.values(result.fields||{}).filter(field=>field.value!==null).map(field=>field.field+': '+field.value+(field.unit?' '+field.unit:''));output.textContent=result.status+(result.healStatus&&result.healStatus!=='NOT_NEEDED'?' · heal '+result.healStatus:'')+(button.dataset.action==='test'&&values.length?' · '+values.join(' · '):'');if(button.dataset.action==='run')setTimeout(()=>location.reload(),500)}catch(error){output.textContent=error.message}finally{for(const item of buttons)item.disabled=false}})})();</script></body></html>`;
}
