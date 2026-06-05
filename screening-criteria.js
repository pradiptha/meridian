import fs from "fs";
import { config } from "./config.js";

const SCREENING_CRITERIA_HISTORY_FILE = "./screening-criteria-history.json";

function cloneList(values) {
  return Array.isArray(values) ? [...values] : [];
}

function maybeNumber(value, decimals = null) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (decimals == null) return n;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function compactObject(obj) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, value]) => value !== undefined),
  );
}

function numeric(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function getFirstTokenResult(payload) {
  if (!payload?.found || !Array.isArray(payload.results) || payload.results.length === 0) return null;
  return payload.results[0];
}

function loadHistory() {
  if (!fs.existsSync(SCREENING_CRITERIA_HISTORY_FILE)) {
    return { events: [], lastUpdated: null };
  }
  try {
    return JSON.parse(fs.readFileSync(SCREENING_CRITERIA_HISTORY_FILE, "utf8"));
  } catch {
    return { events: [], lastUpdated: null };
  }
}

function saveHistory(history) {
  history.lastUpdated = new Date().toISOString();
  fs.writeFileSync(SCREENING_CRITERIA_HISTORY_FILE, JSON.stringify(history, null, 2));
}

export function captureScreeningCriteriaSnapshot({
  phase,
  closeReason = null,
  poolMetrics = null,
} = {}) {
  const screening = config.screening || {};
  const strategy = config.strategy || {};

  return compactObject({
    phase: phase || null,
    captured_at: new Date().toISOString(),
    source: screening.source ?? null,
    timeframe: screening.timeframe ?? null,
    category: screening.category ?? null,
    close_reason: closeReason || undefined,
    thresholds: {
      minFeeActiveTvlRatio: maybeNumber(screening.minFeeActiveTvlRatio, 4),
      minTvl: maybeNumber(screening.minTvl),
      maxTvl: maybeNumber(screening.maxTvl),
      minVolume: maybeNumber(screening.minVolume),
      minOrganic: maybeNumber(screening.minOrganic),
      minQuoteOrganic: maybeNumber(screening.minQuoteOrganic),
      minHolders: maybeNumber(screening.minHolders),
      minMcap: maybeNumber(screening.minMcap),
      maxMcap: maybeNumber(screening.maxMcap),
      minBinStep: maybeNumber(screening.minBinStep),
      maxBinStep: maybeNumber(screening.maxBinStep),
      minTokenFeesSol: maybeNumber(screening.minTokenFeesSol, 4),
      maxBundlePct: maybeNumber(screening.maxBundlePct, 4),
      maxBotHoldersPct: maybeNumber(screening.maxBotHoldersPct, 4),
      maxTop10Pct: maybeNumber(screening.maxTop10Pct, 4),
      minTokenAgeHours: maybeNumber(screening.minTokenAgeHours),
      maxTokenAgeHours: maybeNumber(screening.maxTokenAgeHours),
      athFilterPct: maybeNumber(screening.athFilterPct, 4),
      blockedLaunchpads: cloneList(screening.blockedLaunchpads),
      allowedLaunchpads: cloneList(screening.allowedLaunchpads),
      useDiscordSignals: !!screening.useDiscordSignals,
      discordSignalMode: screening.discordSignalMode ?? null,
      avoidPvpSymbols: !!screening.avoidPvpSymbols,
      blockPvpSymbols: !!screening.blockPvpSymbols,
      excludeHighSupplyConcentration: screening.excludeHighSupplyConcentration ?? null,
    },
    strategy: {
      strategy: strategy.strategy ?? null,
      minBinsBelow: maybeNumber(strategy.minBinsBelow),
      maxBinsBelow: maybeNumber(strategy.maxBinsBelow),
      defaultBinsBelow: maybeNumber(strategy.defaultBinsBelow),
    },
    pool_metrics: poolMetrics
      ? compactObject({
          bin_step: maybeNumber(poolMetrics.bin_step),
          volatility: maybeNumber(poolMetrics.volatility, 6),
          fee_tvl_ratio: maybeNumber(poolMetrics.fee_tvl_ratio, 6),
          organic_score: maybeNumber(poolMetrics.organic_score, 4),
          quote_organic_score: maybeNumber(poolMetrics.quote_organic_score, 4),
          volume: maybeNumber(poolMetrics.volume, 2),
          tvl: maybeNumber(poolMetrics.tvl, 2),
          mcap: maybeNumber(poolMetrics.mcap, 2),
          holder_count: maybeNumber(poolMetrics.holder_count),
          token_fees_sol: maybeNumber(poolMetrics.token_fees_sol, 6),
          bundle_pct: maybeNumber(poolMetrics.bundle_pct, 4),
          bot_holders_pct: maybeNumber(poolMetrics.bot_holders_pct, 4),
          top10_pct: maybeNumber(poolMetrics.top10_pct, 4),
          launchpad: poolMetrics.launchpad ?? undefined,
        })
      : undefined,
  });
}

export async function captureEnrichedScreeningCriteriaSnapshot({
  phase,
  closeReason = null,
  poolAddress = null,
  baseMint = null,
  fallbackPoolMetrics = null,
} = {}) {
  let detail = null;
  let tokenInfo = null;
  let tokenHolders = null;

  if (poolAddress) {
    try {
      const { getPoolDetail } = await import("./tools/screening.js");
      detail = await getPoolDetail({
        pool_address: poolAddress,
        timeframe: config.screening?.timeframe || "5m",
      });
    } catch {
      detail = null;
    }
  }

  if (baseMint) {
    const [{ getTokenInfo }, { getTokenHolders }] = await Promise.all([
      import("./tools/token.js"),
      import("./tools/token.js"),
    ]);
    const [tokenInfoResult, tokenHoldersResult] = await Promise.all([
      getTokenInfo({ query: baseMint }).catch(() => null),
      getTokenHolders({ mint: baseMint, limit: 20 }).catch(() => null),
    ]);
    tokenInfo = getFirstTokenResult(tokenInfoResult);
    tokenHolders = tokenHoldersResult;
  }

  const fallback = fallbackPoolMetrics || {};
  const baseToken = detail?.token_x || {};
  const quoteToken = detail?.token_y || {};

  const poolMetrics = {
    bin_step: numeric(detail?.dlmm_params?.bin_step) ?? numeric(fallback.bin_step),
    volatility: numeric(detail?.volatility) ?? numeric(fallback.volatility),
    fee_tvl_ratio: numeric(detail?.fee_active_tvl_ratio) ?? numeric(fallback.fee_tvl_ratio),
    organic_score: numeric(baseToken?.organic_score) ?? numeric(tokenInfo?.organic_score) ?? numeric(fallback.organic_score),
    quote_organic_score: numeric(quoteToken?.organic_score) ?? numeric(fallback.quote_organic_score),
    volume: numeric(detail?.volume) ?? numeric(detail?.volume_window) ?? numeric(fallback.volume),
    tvl: numeric(detail?.tvl) ?? numeric(detail?.active_tvl) ?? numeric(fallback.tvl),
    mcap: numeric(baseToken?.market_cap) ?? numeric(tokenInfo?.mcap) ?? numeric(fallback.mcap),
    holder_count: numeric(detail?.base_token_holders) ?? numeric(tokenInfo?.holders) ?? numeric(tokenHolders?.total_fetched) ?? numeric(fallback.holder_count),
    token_fees_sol: numeric(tokenInfo?.global_fees_sol) ?? numeric(tokenHolders?.global_fees_sol) ?? numeric(fallback.token_fees_sol),
    bundle_pct: numeric(tokenInfo?.bundle_pct) ?? numeric(tokenHolders?.bundle_pct) ?? numeric(fallback.bundle_pct),
    bot_holders_pct: numeric(tokenInfo?.audit?.bot_holders_pct) ?? numeric(fallback.bot_holders_pct),
    top10_pct: numeric(tokenInfo?.audit?.top_holders_pct) ?? numeric(tokenHolders?.top_10_real_holders_pct) ?? numeric(fallback.top10_pct),
    launchpad: baseToken?.launchpad || detail?.base_token_launchpad || detail?.launchpad || tokenInfo?.launchpad || fallback.launchpad,
  };

  return captureScreeningCriteriaSnapshot({
    phase,
    closeReason,
    poolMetrics,
  });
}

export function appendScreeningCriteriaEvent({
  event,
  position = null,
  pool = null,
  pool_name = null,
  base_mint = null,
  snapshot,
}) {
  if (!snapshot || typeof snapshot !== "object") return false;

  const history = loadHistory();
  history.events.push(compactObject({
    event: event || snapshot.phase || null,
    recorded_at: new Date().toISOString(),
    position,
    pool,
    pool_name,
    base_mint,
    snapshot,
  }));
  saveHistory(history);
  return true;
}
