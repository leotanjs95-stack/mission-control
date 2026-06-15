// Mission Control — status refresher.
// Runs on a GitHub Actions schedule. Queries live data sources (Supabase for
// Nova/leads), assembles a single data/status.json that the static dashboard
// reads in the browser. Keeps all secrets server-side.
import { createClient } from "@supabase/supabase-js";
import { writeFileSync, mkdirSync } from "node:fs";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

const STUCK_MIN = 20;            // a pending/scraping job older than this = unhealthy
const now = Date.now();
const iso = (d) => new Date(d).toISOString();
const minutesAgo = (ts) => (now - new Date(ts).getTime()) / 60000;

function humanAgo(ts) {
  if (!ts) return "—";
  const m = minutesAgo(ts);
  if (m < 1) return "just now";
  if (m < 60) return `${Math.round(m)}m ago`;
  const h = m / 60;
  if (h < 24) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

// ---- Nova: live from Supabase ----
async function buildNova() {
  const a = { id: "nova", name: "Nova", role: "Lead Generation", skill: "Lead Scraper",
    accent: "nova", mode: "auto", modeLabel: "⚡ Auto · every 5 min" };
  try {
    const [{ count: totalLeads }, jobsRes, leadsTrendRes] = await Promise.all([
      supabase.from("leads").select("*", { count: "exact", head: true }),
      supabase.from("scrape_jobs").select("id,industry,country,status,total_leads,created_at,completed_at,error_message")
        .order("created_at", { ascending: false }).limit(50),
      supabase.from("leads").select("created_at").gte("created_at", iso(now - 14 * 86400000)).limit(5000),
    ]);
    const jobs = jobsRes.data || [];
    const completed = jobs.filter((j) => j.status === "completed");
    const failed = jobs.filter((j) => j.status === "failed");
    const active = jobs.filter((j) => j.status === "pending" || j.status === "scraping");
    const stuck = active.filter((j) => minutesAgo(j.created_at) > STUCK_MIN);

    // health
    let health = "ok", note = "All scrapes flowing";
    if (stuck.length) { health = "down"; note = `${stuck.length} scrape(s) stuck >${STUCK_MIN}m`; }
    else if (active.length) { health = "warn"; note = `${active.length} scrape(s) running`; }

    // trend: leads/day for last 14 days
    const buckets = {};
    for (let i = 13; i >= 0; i--) {
      const d = new Date(now - i * 86400000).toISOString().slice(0, 10);
      buckets[d] = 0;
    }
    for (const l of leadsTrendRes.data || []) {
      const d = (l.created_at || "").slice(0, 10);
      if (d in buckets) buckets[d]++;
    }
    const trend = Object.entries(buckets).map(([date, count]) => ({ date, count }));

    a.status = active.length ? "Working" : "Live";
    a.health = health;
    a.healthNote = note;
    a.metrics = [
      { k: "Leads captured", v: String(totalLeads ?? 0) },
      { k: "Completed scrapes", v: String(completed.length) },
      { k: "Running now", v: String(active.length) },
      { k: "Last scrape", v: jobs[0] ? humanAgo(jobs[0].completed_at || jobs[0].created_at) : "—" },
    ];
    a.trend = trend;
    a.activity = jobs.slice(0, 6).map((j) => ({
      text: `${j.industry} · ${j.country}` + (j.status === "completed" ? ` → ${j.total_leads ?? 0} leads`
        : j.status === "failed" ? " → failed" : ` → ${j.status}`),
      when: humanAgo(j.completed_at || j.created_at),
      status: j.status,
    }));
  } catch (e) {
    a.status = "Unknown"; a.health = "down"; a.healthNote = "Could not reach Supabase";
    a.metrics = [{ k: "Error", v: String(e.message).slice(0, 40) }]; a.trend = []; a.activity = [];
  }
  return a;
}

// ---- Gem / Cher / PJ: configured status (no live feed wired yet) ----
function staticAgent(cfg) {
  return { health: "ok", healthNote: cfg.mode === "auto" ? "Scheduled & armed" : "Ready on request",
    trend: [], activity: [], ...cfg };
}

// ---- Gem: live from GitHub Actions run history (meta-ads-monitor repo) ----
const GH_TOKEN = process.env.GH_READ_TOKEN;
const META_REPO = "leotanjs95-stack/meta-ads-monitor";

async function buildGem() {
  const base = staticAgent({
    id: "gem", name: "Gem", role: "Meta Agent", skill: "Meta Ads Reporting", accent: "gem",
    mode: "auto", modeLabel: "⚡ Auto · weekly", status: "Live",
    metrics: [
      { k: "Schedule", v: "Weekly · Fri 1:30 PM SGT" },
      { k: "Channels", v: "3 Lark groups" },
      { k: "Accounts", v: "Catalyst Outsourcing" },
      { k: "Output", v: "SCALE / PAUSE / FIX" },
    ],
  });
  if (!GH_TOKEN) return base; // no token yet → keep configured status
  try {
    const r = await fetch(`https://api.github.com/repos/${META_REPO}/actions/runs?per_page=20`, {
      headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: "application/vnd.github+json" },
    });
    if (!r.ok) throw new Error(`GitHub API ${r.status}`);
    const runs = (await r.json()).workflow_runs || [];
    // prefer the Catalyst report workflow; fall back to most recent run
    const run = runs.find((x) => /catalyst/i.test(x.name || "")) || runs[0];
    if (!run) return base;
    const ok = run.conclusion === "success";
    base.health = ok ? "ok" : "down";
    base.healthNote = ok ? "Last report sent OK" : `Last report ${run.conclusion || run.status}`;
    base.status = run.status === "in_progress" ? "Working" : "Live";
    base.metrics = [
      { k: "Last report", v: humanAgo(run.run_started_at || run.created_at) },
      { k: "Last result", v: ok ? "✅ Sent" : `⚠️ ${run.conclusion || run.status}` },
      { k: "Channels", v: "3 Lark groups" },
      { k: "Accounts", v: "Catalyst Outsourcing" },
    ];
    base.activity = runs.slice(0, 4).map((x) => ({
      text: `${x.name} → ${x.conclusion || x.status}`,
      when: humanAgo(x.run_started_at || x.created_at),
      status: x.conclusion === "success" ? "completed" : x.conclusion ? "failed" : "scraping",
    }));
  } catch (e) {
    base.healthNote = "Run history unavailable";
  }
  return base;
}
const cher = staticAgent({
  id: "cher", name: "Cher", role: "Google Ads", skill: "Google Ads Reporting", accent: "cher",
  mode: "ond", modeLabel: "✋ On-demand · ask Claude", status: "Ready",
  metrics: [
    { k: "Output", v: "KPIs + recommendations" },
    { k: "Channel", v: "Lark" },
    { k: "Scope", v: "Search · PMax" },
    { k: "Run it", v: '"Cher, pull this week"' },
  ],
});
const pj = staticAgent({
  id: "pj", name: "PJ", role: "Video Editor", skill: "Higgsfield Studio", accent: "pj",
  mode: "ond", modeLabel: "✋ On-demand · ask Claude", status: "Ready",
  metrics: [
    { k: "Capabilities", v: "Image · Video · Audio" },
    { k: "Engine", v: "Higgsfield Soul" },
    { k: "Extras", v: "Virality predictor" },
    { k: "Run it", v: '"PJ, make a 9:16 ad"' },
  ],
});

(async () => {
  const [gem, nova] = await Promise.all([buildGem(), buildNova()]);
  const agents = [gem, cher, nova, pj];
  const novaLeads = Number(nova.metrics?.find((m) => m.k === "Leads captured")?.v || 0);
  const novaScrapes = Number(nova.metrics?.find((m) => m.k === "Completed scrapes")?.v || 0);
  const status = {
    generatedAt: iso(now),
    totals: {
      agentsOnline: agents.length,
      leads: novaLeads,
      scrapes: novaScrapes,
      automations: agents.filter((a) => a.mode === "auto").length,
    },
    agents,
  };
  mkdirSync("data", { recursive: true });
  writeFileSync("data/status.json", JSON.stringify(status, null, 2));
  console.log(`Wrote data/status.json — ${novaLeads} leads, ${novaScrapes} scrapes, health=${nova.health}`);
})().catch((e) => { console.error("REFRESH FAILED:", e.message); process.exit(1); });
