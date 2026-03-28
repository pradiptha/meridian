import fs from "fs";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import "dotenv/config";
import { log } from "../logger.js";

function getWallet() {
  if (!process.env.WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY not set");
  return Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
}

const LESSONS_FILE = "./lessons.json";

export async function fetchClosedPositionsFromApi(poolAddress) {
  const wallet = getWallet();
  if (!wallet) {
    throw new Error("Wallet not configured");
  }
  const walletAddress = wallet.publicKey.toString();
  
  const allPositions = [];
  let page = 1;
  let hasNext = true;
  
  while (hasNext) {
    const url = `https://dlmm.datapi.meteora.ag/positions/${poolAddress}/pnl?user=${walletAddress}&status=closed&pageSize=50&page=${page}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`API error ${res.status}: ${await res.text().catch(() => "")}`);
    }
    const data = await res.json();
    
    if (data.positions && data.positions.length > 0) {
      allPositions.push(...data.positions);
    }
    
    hasNext = data.hasNext === true;
    page++;
    
    if (page > 20) break;
  }
  
  return allPositions;
}

export async function repairPerformanceData({ dryRun = false, poolFilter = null } = {}) {
  const data = load();
  if (!data.performance || data.performance.length === 0) {
    log("repair", "No performance data to repair");
    return { updated: 0, skipped: 0, errors: [] };
  }

  const wallet = getWallet();
  const walletAddress = wallet.publicKey.toString();
  
  const errors = [];
  let updated = 0;
  let skipped = 0;
  
  const byPool = {};
  for (const perf of data.performance) {
    const pool = perf.pool;
    if (!byPool[pool]) byPool[pool] = [];
    byPool[pool].push(perf);
  }

  for (const [poolAddress, perfs] of Object.entries(byPool)) {
    if (poolFilter && poolAddress !== poolFilter) {
      skipped += perfs.length;
      continue;
    }

    log("repair", `Fetching closed positions for pool ${poolAddress}...`);
    let apiPositions = [];
    try {
      apiPositions = await fetchClosedPositionsFromApi(poolAddress);
    } catch (e) {
      log("repair_error", `Failed to fetch for pool ${poolAddress}: ${e.message}`);
      errors.push(`${poolAddress}: ${e.message}`);
      continue;
    }

    const apiByPos = {};
    for (const p of apiPositions) {
      apiByPos[p.positionAddress] = p;
    }

    for (const perf of perfs) {
      const apiPos = apiByPos[perf.position];
      
      if (!apiPos) {
        log("repair_warn", `Position ${perf.position} not found in API (pool ${poolAddress})`);
        skipped++;
        continue;
      }

      const apiInitialUsd = parseFloat(apiPos.allTimeDeposits?.total?.usd || 0);
      const apiFeesUsd = parseFloat(apiPos.allTimeFees?.total?.usd || 0);
      const currentInitial = perf.initial_value_usd || 0;
      
      const isWrong = apiInitialUsd > 5 && apiInitialUsd < 500 && 
                      Math.abs(currentInitial - apiInitialUsd) > 10;
      
      if (isWrong) {
        const oldPnl = perf.pnl_pct;
        const oldInitial = perf.initial_value_usd;
        
        if (!dryRun) {
          perf.initial_value_usd = apiInitialUsd;
          perf.fees_earned_usd = Math.round(apiFeesUsd * 100) / 100;
          
          const pnlUsdCalc = (perf.final_value_usd + perf.fees_earned_usd) - perf.initial_value_usd;
          const pnlPctCalc = perf.initial_value_usd > 0 
            ? (pnlUsdCalc / perf.initial_value_usd) * 100 
            : 0;
          perf.pnl_usd = Math.round(pnlUsdCalc * 100) / 100;
          perf.pnl_pct = Math.round(pnlPctCalc * 100) / 100;
          
          perf.recorded_at = new Date().toISOString();
        }
        log("repair", `[${dryRun ? "DRY-RUN" : "UPDATED"}] ${perf.pool_name}: initial $${oldInitial} → $${apiInitialUsd}, pnl ${oldPnl}% → ${perf.pnl_pct}%`);
        updated++;
      } else {
        skipped++;
      }
    }
  }

  if (!dryRun && updated > 0) {
    save(data);
    log("repair", `Saved ${updated} repaired entries`);
  }

  return { updated, skipped, errors };
}

function load() {
  if (!fs.existsSync(LESSONS_FILE)) {
    return { lessons: [], performance: [] };
  }
  return JSON.parse(fs.readFileSync(LESSONS_FILE, "utf8"));
}

function save(data) {
  fs.writeFileSync(LESSONS_FILE, JSON.stringify(data, null, 2));
}