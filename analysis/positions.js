#!/usr/bin/env node
/**
 * Meridian position analysis — reads state.json, classifies closes,
 * and renders a markdown report with the three-metric split:
 *   - Strategy win rate  (clean TP / (clean TP + SL + agent/manual))
 *   - Forced-exit rate   (OOR + RULE + YIELD / total)
 *   - Net PnL            (placeholder — recordClaim() blind spot)
 *
 * Usage:
 *   node analysis/positions.js [--month=YYYY-MM | --days=N] [--out=PATH] [--json]
 *
 * Default: month=current, out=docs/<month>-analysis-v2.md
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { repoPath } from "../repo-root.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── CLI ────────────────────────────────────────────────────────

function usage() {
  console.log(`Usage:
  node analysis/positions.js [--month=YYYY-MM | --days=N] [--out=PATH] [--json]

Options:
  --month=YYYY-MM   Filter by deployed_at within the month (default: current month)
  --days=N          Rolling N-day window ending at the latest deploy in state.json
  --out=PATH        Output markdown path (default: docs/<month>-analysis-v2.md)
                    Pass "-" to print markdown to stdout only (no file write)
  --json            Also print a JSON summary to stdout`);
  process.exit(0);
}

function parseArgs(argv) {
  const args = {
    month: null,
    days: null,
    out: null,
    json: false,
    help: false,
  };
  for (const a of argv) {
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--json") args.json = true;
    else if (a.startsWith("--month=")) args.month = a.slice("--month=".length);
    else if (a.startsWith("--days=")) args.days = parseInt(a.slice("--days=".length), 10);
    else if (a.startsWith("--out=")) args.out = a.slice("--out=".length);
    else if (a === "-") args.out = "-";
  }
  return args;
}

// ─── Data loading ───────────────────────────────────────────────

function loadState() {
  const statePath = repoPath("state.json");
  if (!fs.existsSync(statePath)) {
    throw new Error(`state.json not found at ${statePath}`);
  }
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch (err) {
    throw new Error(`Failed to parse state.json: ${err.message}`);
  }
}

function getRangeBounds(positions, args) {
  const deployedTs = positions
    .map((p) => p.deployed_at)
    .filter(Boolean)
    .map((t) => new Date(t).getTime())
    .filter((t) => Number.isFinite(t));
  if (deployedTs.length === 0) {
    throw new Error("No positions with deployed_at in state.json");
  }
  const maxTs = Math.max(...deployedTs);

  if (args.days != null && Number.isFinite(args.days) && args.days > 0) {
    const start = new Date(maxTs - args.days * 24 * 60 * 60 * 1000);
    return { start, end: new Date(maxTs + 1), label: `last ${args.days} days (ending ${new Date(maxTs).toISOString().slice(0, 10)})` };
  }

  const month = args.month || new Date(maxTs).toISOString().slice(0, 7);
  const [yStr, mStr] = month.split("-");
  const y = parseInt(yStr, 10);
  const m = parseInt(mStr, 10);
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) {
    throw new Error(`Invalid --month=${month} (expected YYYY-MM)`);
  }
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 1));
  return { start, end, label: month };
}

function filterRange(positions, { start, end }) {
  return positions.filter((p) => {
    if (!p.deployed_at) return false;
    const t = new Date(p.deployed_at).getTime();
    return t >= start.getTime() && t < end.getTime();
  });
}

function getClosed(positions) {
  return positions.filter((p) => p.closed);
}

function getOpen(positions) {
  return positions.filter((p) => !p.closed);
}

// ─── Classification ─────────────────────────────────────────────

/**
 * Pull the real close note (skipping the "Auto-closed during state sync" stub).
 */
function getRealCloseNote(pos) {
  for (const note of pos.notes || []) {
    if (typeof note === "string" && note.startsWith("Closed at ") && !note.includes("Auto-closed")) {
      return note;
    }
  }
  return null;
}

/**
 * Classify a position into one of the buckets below.
 * Returns { bucket, realNote }.
 *
 *   WIN_CLEAN       — Trailing TP fired cleanly (no OOR trigger, no low-yield co-trigger), peak typically >= 2%
 *   WIN_LOWYIELD    — Trailing TP fired with low-yield co-trigger (peak usually < 2%)
 *   WIN_MANUAL      — Manual "take profit" close
 *   LOSS_OOR        — "Out of range", "OOR", or "pumped far above range" — incl. Trailing-TP-tagged OOR exits
 *   LOSS_RULE       — Screener rule forced close (e.g. "Rule 3: pumped far above range")
 *   LOSS_YIELD      — Low-yield exit with peak PnL < 1.5% and no TP
 *   LOSS_SL         — Stop loss triggered
 *   NEUTRAL_AGENT   — Agent discretionary decision
 *   NEUTRAL_REBAL   — Rebalance close
 *   NEUTRAL_USER    — User override
 *   OTHER           — Anything else
 */
function classify(pos) {
  const note = getRealCloseNote(pos);
  if (!note) return { bucket: "OTHER", realNote: null };
  const n = note.toLowerCase();

  // Trailing TP without OOR trigger (clean or low-yield co-trigger)
  if (n.includes("trailing tp") && !n.includes("out of range") && !n.includes("oor") && !n.includes("pumped")) {
    if (n.includes("low yield")) return { bucket: "WIN_LOWYIELD", realNote: note };
    return { bucket: "WIN_CLEAN", realNote: note };
  }
  if (n.includes("take profit") && !n.includes("out of range") && !n.includes("oor")) {
    return { bucket: "WIN_MANUAL", realNote: note };
  }
  if (n.includes("out of range") || /\boor\b/.test(n) || n.includes("pumped far above")) {
    if (n.includes("rule") && n.includes("close")) return { bucket: "LOSS_RULE", realNote: note };
    return { bucket: "LOSS_OOR", realNote: note };
  }
  if (n.includes("stop loss")) return { bucket: "LOSS_SL", realNote: note };
  if (n.includes("low yield")) return { bucket: "LOSS_YIELD", realNote: note };
  if (n.includes("rule") && n.includes("close")) return { bucket: "LOSS_RULE", realNote: note };
  if (n.includes("agent decision")) return { bucket: "NEUTRAL_AGENT", realNote: note };
  if (n.includes("rebalance")) return { bucket: "NEUTRAL_REBAL", realNote: note };
  if (n.includes("user requested")) return { bucket: "NEUTRAL_USER", realNote: note };
  return { bucket: "OTHER", realNote: note };
}

// Agent-decision outcomes: included in strategy win rate (TP/SL + discretionary agent).
// NEUTRAL_USER and NEUTRAL_REBAL are excluded — those are operator or mechanical exits, not TP/SL quality.
const STRATEGY_WIN = new Set(["WIN_CLEAN", "WIN_MANUAL", "NEUTRAL_AGENT"]);
const STRATEGY_LOSS = new Set(["LOSS_SL"]);
const FORCED = new Set(["LOSS_OOR", "LOSS_RULE", "LOSS_YIELD"]);
const LOWYIELD = new Set(["WIN_LOWYIELD", "LOSS_YIELD"]);

/**
 * The three metrics:
 *   - strategyWR  = (WIN_CLEAN + WIN_MANUAL + NEUTRAL_AGENT) / (those + LOSS_SL)
 *                   NEUTRAL_REBAL/USER are excluded (not TP/SL decisions)
 *   - forcedRate  = (LOSS_OOR + LOSS_RULE + LOSS_YIELD) / total closed
 *   - netPnl      = null (recordClaim() blind spot — see caveats)
 */
function threeMetrics(positions) {
  const total = positions.length;
  const strategyWin = positions.filter((p) => ["WIN_CLEAN", "WIN_MANUAL", "NEUTRAL_AGENT"].includes(p._bucket)).length;
  const strategyLoss = positions.filter((p) => p._bucket === "LOSS_SL").length;
  const strategyDenom = strategyWin + strategyLoss;
  const forced = positions.filter((p) => FORCED.has(p._bucket)).length;
  const lowyield = positions.filter((p) => LOWYIELD.has(p._bucket)).length;
  return {
    total,
    strategyWR: strategyDenom > 0 ? strategyWin / strategyDenom : null,
    forcedRate: total > 0 ? forced / total : null,
    lowyieldRate: total > 0 ? lowyield / total : null,
    strategyWin,
    strategyLoss,
    forced,
    lowyield,
  };
}

// ─── Bucket helpers for per-factor tables ───────────────────────

function bucketVolatility(p) {
  const v = p.volatility || 0;
  if (v <= 0) return "N/A";
  if (v < 2) return "<2";
  if (v < 3) return "2-3";
  if (v < 4) return "3-4";
  if (v < 5) return "4-5";
  return "5+";
}

function bucketFeeTvl(p) {
  const v = p.fee_tvl_ratio || 0;
  if (v <= 0) return "N/A";
  if (v < 0.2) return "<0.2";
  if (v < 0.5) return "0.2-0.5";
  if (v < 1.0) return "0.5-1.0";
  if (v < 2.0) return "1.0-2.0";
  return "2.0+";
}

function bucketOrganic(p) {
  const v = p.organic_score || 0;
  if (v <= 0) return "N/A";
  if (v < 70) return "<70";
  if (v < 80) return "70-80";
  if (v < 90) return "80-90";
  return "90+";
}

function bucketBinStep(p) {
  const v = p.bin_step || 0;
  if (v === 80 || v === 100 || v === 125) return String(v);
  return String(v);
}

function bucketBinsBelow(p) {
  const br = p.bin_range || {};
  const b = br.bins_below || 0;
  if (b <= 0) return "N/A";
  if (b < 90) return "<90";
  if (b < 120) return "90-120";
  if (b < 140) return "120-140";
  return "140+";
}

function bucketHolders(p) {
  const ss = p.signal_snapshot || {};
  const v = ss.holder_count || 0;
  if (v <= 0) return "N/A";
  if (v < 1000) return "<1000";
  if (v < 2500) return "1000-2500";
  if (v < 5000) return "2500-5000";
  return "5000+";
}

function bucketMcap(p) {
  const ss = p.signal_snapshot || {};
  const v = ss.mcap || 0;
  if (v <= 0) return "N/A";
  if (v < 300000) return "<300k";
  if (v < 700000) return "300k-700k";
  if (v < 1500000) return "700k-1.5M";
  if (v < 3000000) return "1.5M-3M";
  return "3M+";
}

function bucketSmartWallets(p) {
  const ss = p.signal_snapshot || {};
  if (ss.smart_wallets_present === true) return "YES";
  if (ss.smart_wallets_present === false) return "NO";
  return "N/A";
}

function bucketNarrative(p) {
  const ss = p.signal_snapshot || {};
  if (ss.narrative_quality == null) return "N/A";
  return String(ss.narrative_quality);
}

function bucketInitialValue(p) {
  const v = p.initial_value_usd || 0;
  if (v <= 0) return "N/A";
  if (v < 50) return "<$50";
  if (v < 100) return "$50-100";
  if (v < 500) return "$100-500";
  if (v < 2000) return "$500-2k";
  return "$2k+";
}

// ─── Aggregation ────────────────────────────────────────────────

function aggregate(positions, keyFn, bucketOrder) {
  const groups = new Map();
  for (const p of positions) {
    const key = keyFn(p);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  const rows = [];
  for (const [key, group] of groups) {
    const m = threeMetrics(group);
    rows.push({ key, ...m });
  }
  rows.sort((a, b) => {
    const ai = bucketOrder ? bucketOrder.indexOf(a.key) : -1;
    const bi = bucketOrder ? bucketOrder.indexOf(b.key) : -1;
    if (ai === -1 && bi === -1) return a.key.localeCompare(b.key);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
  return rows;
}

// ─── Drift (deploy vs close pool_metrics) ───────────────────────

function metricOf(pm, key, fallback = 0) {
  if (!pm) return fallback;
  const v = pm[key];
  if (v == null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function driftFor(positions, label) {
  const metrics = ["volatility", "fee_tvl_ratio", "mcap", "volume", "holder_count", "organic_score"];
  const out = { label, n: positions.length, rows: [] };
  for (const m of metrics) {
    const dVals = [];
    const cVals = [];
    for (const p of positions) {
      const sc_d = p.screening_criteria_at_deploy || {};
      const sc_c = p.screening_criteria_at_close || {};
      const pm_d = sc_d.pool_metrics || {};
      const pm_c = sc_c.pool_metrics || {};
      const d = metricOf(pm_d, m);
      const c = metricOf(pm_c, m);
      if (d > 0 && c > 0) {
        dVals.push(d);
        cVals.push(c);
      }
    }
    if (dVals.length === 0) {
      out.rows.push({ metric: m, deploy: null, close: null, delta: null, pctDelta: null, up: 0, down: 0, paired: 0 });
      continue;
    }
    const avgD = dVals.reduce((a, b) => a + b, 0) / dVals.length;
    const avgC = cVals.reduce((a, b) => a + b, 0) / cVals.length;
    let up = 0, down = 0;
    let pctSum = 0;
    for (let i = 0; i < dVals.length; i++) {
      if (cVals[i] > dVals[i]) up++;
      else if (cVals[i] < dVals[i]) down++;
      if (dVals[i] !== 0) pctSum += ((cVals[i] - dVals[i]) / dVals[i]) * 100;
    }
    out.rows.push({
      metric: m,
      deploy: avgD,
      close: avgC,
      delta: avgC - avgD,
      pctDelta: pctSum / dVals.length,
      up,
      down,
      paired: dVals.length,
    });
  }
  return out;
}

// ─── Pool concentration ────────────────────────────────────────

function poolBreakdown(positions) {
  const stats = new Map();
  for (const p of positions) {
    const name = p.pool_name || "(none)";
    if (!stats.has(name)) stats.set(name, { pool: name, total: 0, win: 0, loss: 0, forced: 0, lowyield: 0 });
    const s = stats.get(name);
    s.total++;
    if (p._bucket === "WIN_CLEAN" || p._bucket === "WIN_MANUAL" || p._bucket === "NEUTRAL_AGENT") s.win++;
    else if (p._bucket === "LOSS_SL") s.loss++;
    if (FORCED.has(p._bucket)) s.forced++;
    if (LOWYIELD.has(p._bucket)) s.lowyield++;
  }
  return Array.from(stats.values());
}

// ─── Time-of-day ───────────────────────────────────────────────

function timeOfDayStats(positions) {
  const out = [];
  for (let h = 0; h < 24; h++) out.push({ hour: h, total: 0, win: 0, loss: 0, forced: 0 });
  for (const p of positions) {
    if (!p.deployed_at) continue;
    const h = new Date(p.deployed_at).getUTCHours();
    const row = out[h];
    row.total++;
    if (p._bucket === "WIN_CLEAN" || p._bucket === "WIN_MANUAL" || p._bucket === "NEUTRAL_AGENT") row.win++;
    else if (p._bucket === "LOSS_SL") row.loss++;
    if (FORCED.has(p._bucket)) row.forced++;
  }
  return out;
}

// ─── Markdown rendering ───────────────────────────────────────

function pct(v, digits = 1) {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(digits)}%`;
}

function fmtNum(v, digits = 2) {
  if (v == null || !Number.isFinite(v)) return "—";
  return v.toFixed(digits);
}

function mdTable(headers, rows) {
  const lines = [];
  lines.push(`| ${headers.join(" | ")} |`);
  lines.push(`| ${headers.map(() => "---").join(" | ")} |`);
  for (const r of rows) lines.push(`| ${r.join(" | ")} |`);
  return lines.join("\n");
}

function renderReport({ rangeLabel, generatedAt, all, closed, open, totalFees, classCounts, factorTables, driftBlocks, poolStats, todStats }) {
  const L = [];
  L.push(`# ${rangeLabel} Position Analysis`);
  L.push("");
  L.push(`**Source:** \`state.json\` · **Generated:** ${generatedAt} · **Window:** ${rangeLabel}`);
  L.push("");
  L.push("## 1. Scope");
  L.push("");
  L.push(`- ${all.length} positions deployed (${closed.length} closed, ${open.length} still open).`);
  L.push(`- Total fees claimed (sum of \`total_fees_claimed_usd\`): **$${totalFees.toFixed(2)}** — see Caveats.`);
  L.push(`- Every closed position carries \`signal_snapshot\`, \`screening_criteria_at_deploy\`, and \`screening_criteria_at_close\`.`);
  L.push("");

  L.push("## 2. Methodology");
  L.push("");
  L.push("Close classification parses the **last** `Closed at <ts>: <reason>` note (skipping the auto-close stub).");
  L.push("");
  L.push("Three metrics are reported per factor, not a single blended win rate:");
  L.push("");
  L.push("| Metric | Numerator | Denominator | What it measures |");
  L.push("|---|---|---|---|");
  L.push("| **Strategy win rate** | `WIN_CLEAN + WIN_MANUAL + NEUTRAL_AGENT` | those + `LOSS_SL` | TP/SL logic quality — agent decisions only |");
  L.push("| **Forced-exit rate** | `LOSS_OOR + LOSS_RULE + LOSS_YIELD` | all closed | Risk control — how often the bot was kicked out |");
  L.push("| **Low-yield rate** | `WIN_LOWYIELD + LOSS_YIELD` | all closed | Yield quality — fee decay frequency |");
  L.push("| **Net PnL** | _null_ | — | Unmeasured — `recordClaim()` blind spot |");
  L.push("");
  L.push("### Classification buckets");
  L.push("");
  L.push("| Bucket | Definition |");
  L.push("|---|---|");
  L.push("| `WIN_CLEAN` | Trailing TP fired cleanly (no OOR trigger), peak typically ≥ 2% |");
  L.push("| `WIN_LOWYIELD` | Trailing TP fired with low-yield co-trigger (peak usually < 2%) |");
  L.push("| `WIN_MANUAL` | Manual `take profit` close |");
  L.push("| `LOSS_OOR` | \"Out of range\" / \"OOR\" / \"pumped far above range\" (incl. Trailing-TP-tagged OOR exits) |");
  L.push("| `LOSS_RULE` | Screener rule forced close (e.g. \"Rule 3: pumped far above range\") |");
  L.push("| `LOSS_YIELD` | Low-yield exit, peak < 1.5% |");
  L.push("| `LOSS_SL` | Stop loss triggered |");
  L.push("| `NEUTRAL_*` | Agent / user / rebalance — excluded from strategy WR |");
  L.push("");

  L.push("## 3. Close Reason Distribution");
  L.push("");
  const bucketOrder = [
    "WIN_CLEAN", "WIN_LOWYIELD", "WIN_MANUAL",
    "LOSS_OOR", "LOSS_RULE", "LOSS_YIELD", "LOSS_SL",
    "NEUTRAL_AGENT", "NEUTRAL_REBAL", "NEUTRAL_USER", "OTHER",
  ];
  const countsRows = bucketOrder.map((b) => {
    const c = classCounts[b] || 0;
    return [b, String(c), c > 0 ? pct(c / closed.length) : "—"];
  });
  L.push(mdTable(["Bucket", "Count", "% of closed"], countsRows));
  L.push("");
  const strat = closed.filter((p) => STRATEGY_WIN.has(p._bucket)).length;
  const sl = closed.filter((p) => p._bucket === "LOSS_SL").length;
  const forced = closed.filter((p) => FORCED.has(p._bucket)).length;
  const ly = closed.filter((p) => LOWYIELD.has(p._bucket)).length;
  L.push(`**Strategy win rate:** ${pct((strat) / (strat + sl || 1))} (${strat}W / ${sl}L, denom=${strat + sl} — TP/SL/agent decisions only).  `);
  L.push(`**Forced-exit rate:** ${pct(forced / closed.length)} (${forced} / ${closed.length}).  `);
  L.push(`**Low-yield rate:** ${pct(ly / closed.length)} (${ly} / ${closed.length}).`);
  L.push("");

  L.push("## 4. Deploy → Close Drift (pool_metrics)");
  L.push("");
  for (const block of driftBlocks) {
    if (block.n === 0) continue;
    L.push(`### ${block.label} (n=${block.n})`);
    L.push("");
    const rows = block.rows.map((r) => [
      r.metric,
      r.paired === 0 ? "—" : String(r.paired),
      r.deploy == null ? "—" : fmtNum(r.deploy),
      r.close == null ? "—" : fmtNum(r.close),
      r.delta == null ? "—" : `${r.delta >= 0 ? "+" : ""}${fmtNum(r.delta)}`,
      r.pctDelta == null ? "—" : `${r.pctDelta >= 0 ? "+" : ""}${fmtNum(r.pctDelta, 1)}%`,
      r.paired === 0 ? "—" : `${r.up}/${r.down}`,
    ]);
    L.push(mdTable(["metric", "paired", "deploy", "close", "delta", "avg_pct", "up/down"], rows));
    L.push("");
  }

  L.push("## 5. Per-Factor Tables");
  L.push("");
  L.push("All factors measured at deploy. `n` = total in bucket. Strategy WR and forced-exit rate are independent metrics with different denominators.");
  L.push("");

  const renderFactor = (name, label, rows) => {
    L.push(`### ${label}`);
    L.push("");
    const tableRows = rows.map((r) => [
      r.key,
      String(r.total),
      r.strategyWR == null ? "—" : pct(r.strategyWR),
      `${r.strategyWin}W / ${r.strategyLoss}L`,
      r.forcedRate == null ? "—" : pct(r.forcedRate),
      `${r.forced}L`,
      r.lowyieldRate == null ? "—" : pct(r.lowyieldRate),
    ]);
    L.push(mdTable(["Bucket", "n", "Strategy WR", "W/L (strat)", "Forced-exit", "Forced", "Low-yield"], tableRows));
    L.push("");
  };

  renderFactor("volatility", "5.1 Volatility (deploy)", factorTables.volatility);
  renderFactor("fee_tvl", "5.2 fee_tvl_ratio (deploy)", factorTables.fee_tvl);
  renderFactor("organic", "5.3 organic_score (deploy)", factorTables.organic);
  renderFactor("bin_step", "5.4 bin_step (deploy)", factorTables.bin_step);
  renderFactor("bins_below", "5.5 bins_below (range width)", factorTables.bins_below);
  renderFactor("holders", "5.6 holder_count (signal_snapshot)", factorTables.holders);
  renderFactor("mcap", "5.7 mcap (signal_snapshot, USD)", factorTables.mcap);
  renderFactor("sw", "5.8 smart_wallets_present (signal_snapshot)", factorTables.smart_wallets);
  renderFactor("narrative", "5.9 narrative_quality (signal_snapshot)", factorTables.narrative);
  renderFactor("iv", "5.10 initial_value_usd (position size)", factorTables.iv);

  L.push("## 6. Pool Concentration");
  L.push("");
  L.push(`**${poolStats.length} distinct pools.**`);
  L.push("");
  L.push("### 6.1 Top 15 by deploy count");
  L.push("");
  const topDeploys = [...poolStats].sort((a, b) => b.total - a.total).slice(0, 15);
  L.push(mdTable(
    ["Pool", "Deploys", "Strategy W", "Strategy L", "Forced", "Low-yield", "Forced rate"],
    topDeploys.map((s) => [
      s.pool, String(s.total), String(s.win), String(s.loss), String(s.forced), String(s.lowyield),
      pct(s.forced / (s.total || 1)),
    ]),
  ));
  L.push("");
  L.push("### 6.2 Worst pools by forced-exit rate (n ≥ 3)");
  L.push("");
  const worstForced = poolStats
    .filter((s) => s.total >= 3)
    .map((s) => ({ ...s, rate: s.forced / s.total }))
    .sort((a, b) => b.rate - a.rate)
    .slice(0, 15);
  L.push(mdTable(
    ["Pool", "W (strat)", "L (SL)", "Forced", "n", "Forced rate"],
    worstForced.map((s) => [s.pool, String(s.win), String(s.loss), String(s.forced), String(s.total), pct(s.rate)]),
  ));
  L.push("");

  L.push("## 7. Time-of-Day (deploy hour, UTC)");
  L.push("");
  L.push("`Strategy WR` requires both strategy-W and strategy-L in the hour — small hours may show '—' even with deploys.");
  L.push("");
  L.push(mdTable(
    ["Hour", "Total", "Strategy W", "Strategy L", "Forced", "Strategy WR", "Forced rate"],
    todStats
      .filter((s) => s.total > 0)
      .map((s) => {
        const wrDenom = s.win + s.loss;
        return [
          String(s.hour).padStart(2, "0"),
          String(s.total),
          String(s.win),
          String(s.loss),
          String(s.forced),
          wrDenom > 0 ? pct(s.win / wrDenom) : "—",
          pct(s.forced / s.total),
        ];
      }),
  ));
  L.push("");

  L.push("## 8. Caveats");
  L.push("");
  L.push(`- **\`total_fees_claimed_usd\` is $${totalFees.toFixed(2)}** — \`recordClaim()\` in \`state.js:170-178\` exists but is not firing during the window. Fee revenue is unmeasured, so **Net PnL is null** across the report.`);
  L.push("- **`Auto-closed during state sync` is appended to most notes** by `syncOpenPositions()` in `state.js:525-548`. The classifier skips this stub and reads the real close reason.");
  L.push("- **`pool_metrics` is sparse at deploy** — only `bin_step`, `volatility`, `fee_tvl_ratio`, `organic_score` are populated. The deploy-time features for `volume`/`tvl`/`mcap`/`holders` come from `signal_snapshot` (a separate record).");
  L.push("- **Reclassification of \"Trailing TP: OOR\"** — first-pass analysis treated these as wins because the note starts with \"Trailing TP\". The classifier here treats any exit where OOR / oor / pumped is the actual trigger as `LOSS_OOR` or `LOSS_RULE`.");
  L.push(`- **Strategy WR sample** excludes \`NEUTRAL_REBAL\` and \`NEUTRAL_USER\` (not TP/SL decisions). With those included, the win pool grows but is no longer measuring TP/SL logic quality.`);
  L.push("- **This is a rolling or calendar window**, not necessarily a full month. Check the `Generated` and `Window` lines at the top.");
  L.push("");

  L.push("## 9. How to Re-run");
  L.push("");
  L.push("```bash");
  L.push("# Default (current month):");
  L.push("node analysis/positions.js");
  L.push("");
  L.push("# Specific month:");
  L.push("node analysis/positions.js --month=2026-06");
  L.push("");
  L.push("# Rolling window (last 14 days from latest deploy):");
  L.push("node analysis/positions.js --days=14");
  L.push("");
  L.push("# Print to stdout only, no file write:");
  L.push("node analysis/positions.js --out=-");
  L.push("");
  L.push("# Emit JSON summary in addition to markdown:");
  L.push("node analysis/positions.js --json");
  L.push("```");
  L.push("");

  return L.join("\n");
}

// ─── Main ───────────────────────────────────────────────────────

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) usage();

  const state = loadState();
  const positionsAll = Object.values(state.positions || {});
  const range = getRangeBounds(positionsAll, args);
  const inRange = filterRange(positionsAll, range);
  const closed = getClosed(inRange);
  const open = getOpen(inRange);

  for (const p of closed) {
    p._bucket = classify(p).bucket;
  }
  for (const p of open) {
    p._bucket = "OPEN";
  }

  const classCounts = {};
  for (const p of closed) classCounts[p._bucket] = (classCounts[p._bucket] || 0) + 1;

  const totalFees = closed.reduce((s, p) => s + (p.total_fees_claimed_usd || 0), 0);

  const factorTables = {
    volatility: aggregate(closed, bucketVolatility, ["<2", "2-3", "3-4", "4-5", "5+", "N/A"]),
    fee_tvl: aggregate(closed, bucketFeeTvl, ["<0.2", "0.2-0.5", "0.5-1.0", "1.0-2.0", "2.0+", "N/A"]),
    organic: aggregate(closed, bucketOrganic, ["<70", "70-80", "80-90", "90+", "N/A"]),
    bin_step: aggregate(closed, bucketBinStep, ["80", "100", "125", "0"]),
    bins_below: aggregate(closed, bucketBinsBelow, ["<90", "90-120", "120-140", "140+", "N/A"]),
    holders: aggregate(closed, bucketHolders, ["<1000", "1000-2500", "2500-5000", "5000+", "N/A"]),
    mcap: aggregate(closed, bucketMcap, ["<300k", "300k-700k", "700k-1.5M", "1.5M-3M", "3M+", "N/A"]),
    smart_wallets: aggregate(closed, bucketSmartWallets, ["YES", "NO", "N/A"]),
    narrative: aggregate(closed, bucketNarrative, ["present", "N/A"]),
    iv: aggregate(closed, bucketInitialValue, ["<$50", "$50-100", "$100-500", "$500-2k", "$2k+", "N/A"]),
  };

  const driftBlocks = [
    driftFor(closed.filter((p) => p._bucket === "WIN_CLEAN"), "WIN_CLEAN"),
    driftFor(closed.filter((p) => p._bucket === "WIN_LOWYIELD"), "WIN_LOWYIELD"),
    driftFor(closed.filter((p) => p._bucket === "LOSS_OOR"), "LOSS_OOR"),
    driftFor(closed.filter((p) => p._bucket === "LOSS_YIELD"), "LOSS_YIELD"),
  ];

  const poolStats = poolBreakdown(closed);
  const todStats = timeOfDayStats(closed);

  const generatedAt = new Date().toISOString();
  const rangeLabel = typeof range.label === "string" && /^\d{4}-\d{2}$/.test(range.label)
    ? range.label
    : range.label;

  const report = renderReport({
    rangeLabel,
    generatedAt,
    all: inRange,
    closed,
    open,
    totalFees,
    classCounts,
    factorTables,
    driftBlocks,
    poolStats,
    todStats,
  });

  if (args.out === "-") {
    process.stdout.write(report + "\n");
  } else {
    const outPath = args.out
      ? path.resolve(args.out)
      : path.resolve(repoPath("docs"), `${rangeLabel}-analysis-v2.md`);
    const dir = path.dirname(outPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(outPath, report);
    process.stdout.write(`Wrote ${outPath} (${report.length} bytes, ${closed.length} closed / ${open.length} open)\n`);
  }

  if (args.json) {
    const summary = {
      generatedAt,
      range: { start: range.start.toISOString(), end: range.end.toISOString(), label: rangeLabel },
      total: inRange.length,
      closed: closed.length,
      open: open.length,
      totalFeesClaimedUsd: totalFees,
      classCounts,
      overall: threeMetrics(closed),
    };
    process.stdout.write("\n--- JSON SUMMARY ---\n");
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  }
}

try {
  main();
} catch (err) {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exit(1);
}
