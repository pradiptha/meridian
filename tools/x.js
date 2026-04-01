import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "../logger.js";
import { logSentiment } from "../logger.js";
import { config } from "../config.js";
import { notifyCookieExpired } from "../telegram.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ACCOUNTS_PATH = path.join(__dirname, "../x-accounts.json");

// ─── X Accounts CRUD ──────────────────────────────────────────────

function loadAccounts() {
  if (!fs.existsSync(ACCOUNTS_PATH)) return { accounts: [] };
  try {
    return JSON.parse(fs.readFileSync(ACCOUNTS_PATH, "utf8"));
  } catch {
    return { accounts: [] };
  }
}

function saveAccounts(data) {
  fs.writeFileSync(ACCOUNTS_PATH, JSON.stringify(data, null, 2));
}

export function addXAccount({ handle, category = "alpha" }) {
  handle = handle.replace(/^@/, "").trim().toLowerCase();
  if (!handle || !/^[a-zA-Z0-9_]{1,15}$/.test(handle)) {
    return { success: false, error: "Invalid X handle (1-15 alphanumeric chars, no @)" };
  }
  const data = loadAccounts();
  const existing = data.accounts.find((a) => a.handle === handle);
  if (existing) {
    return { success: false, error: `@${handle} is already in the trusted list` };
  }
  data.accounts.push({ handle, category, addedAt: new Date().toISOString() });
  saveAccounts(data);
  log("x_sentiment", `Added trusted account: @${handle} (${category})`);
  return { success: true, account: { handle, category } };
}

export function removeXAccount({ handle }) {
  handle = handle.replace(/^@/, "").trim().toLowerCase();
  const data = loadAccounts();
  const account = data.accounts.find((a) => a.handle === handle);
  if (!account) return { success: false, error: `@${handle} not found in trusted list` };
  data.accounts = data.accounts.filter((a) => a.handle !== handle);
  saveAccounts(data);
  log("x_sentiment", `Removed trusted account: @${handle}`);
  return { success: true, removed: `@${handle}` };
}

export function listXAccounts() {
  const { accounts } = loadAccounts();
  return { total: accounts.length, accounts };
}

// ─── X Client (lazy init) ─────────────────────────────────────────

let _xClient = null;
let _cookieExpired = false;
let _cookieNotified = false;

async function getXClient() {
  if (_cookieExpired) return null;
  if (_xClient) return _xClient;

  const authToken = process.env.X_AUTH_TOKEN;
  const ct0 = process.env.X_CT0;

  if (!authToken || !ct0) {
    log("x_sentiment", "X cookies not configured (X_AUTH_TOKEN / X_CT0 missing) — sentiment disabled");
    return null;
  }

  try {
    const { XClient } = await import("xreach-cli");
    _xClient = new XClient({ authToken, ct0 }, { timeoutMs: 15000, delayMs: 800, jitterMs: 300 });
    log("x_sentiment", "X client initialized");
    return _xClient;
  } catch (e) {
    log("x_sentiment_error", `Failed to init X client: ${e.message}`);
    return null;
  }
}

function markCookieExpired(reason) {
  if (_cookieExpired) return;
  _cookieExpired = true;
  _xClient = null;
  log("x_sentiment_error", `X cookies expired/invalid: ${reason}`);
  if (!_cookieNotified) {
    _cookieNotified = true;
    notifyCookieExpired(reason).catch(() => {});
  }
}

export function isCookieExpired() {
  return _cookieExpired;
}

/**
 * Reset cookie expiry state (called after user refreshes cookies and restarts).
 */
export function resetCookieState() {
  _cookieExpired = false;
  _cookieNotified = false;
  _xClient = null;
}

/**
 * Lightweight health check — call on startup to validate cookies.
 */
export async function checkCookieHealth() {
  const client = await getXClient();
  if (!client) {
    logSentiment({ event: "health_check", healthy: false, reason: _cookieExpired ? "cookie_expired" : "no_cookies" });
    return { healthy: false, reason: "no_cookies" };
  }
  try {
    await client.search("solana", { type: "latest", count: 1 });
    log("x_sentiment", "Cookie health check passed");
    logSentiment({ event: "health_check", healthy: true });
    return { healthy: true };
  } catch (e) {
    const msg = e.message || String(e);
    if (msg.includes("authenticate") || msg.includes("401") || msg.includes("403") || msg.includes("Could not")) {
      markCookieExpired(msg);
      logSentiment({ event: "health_check", healthy: false, reason: "expired", error: msg });
      return { healthy: false, reason: "expired", message: msg };
    }
    log("x_sentiment_warn", `Cookie health check non-fatal error: ${msg}`);
    logSentiment({ event: "health_check", healthy: true, warning: msg });
    return { healthy: true, warning: msg };
  }
}

// ─── Search ────────────────────────────────────────────────────────

// Cache for handle → restId resolution (24h TTL)
const _handleCache = new Map();
const HANDLE_CACHE_TTL = 24 * 60 * 60 * 1000;

/**
 * Resolve a single handle to its restId using getUser.
 * Results are cached for 24 hours.
 */
async function resolveHandle(client, handle) {
  const cached = _handleCache.get(handle);
  if (cached && Date.now() - cached.fetchedAt < HANDLE_CACHE_TTL) {
    return cached.restId;
  }
  try {
    const user = await client.getUser(handle);
    if (user?.restId) {
      _handleCache.set(handle, { restId: user.restId, name: user.name, fetchedAt: Date.now() });
      log("x_sentiment", `Resolved @${handle} → ${user.restId} (${user.name})`);
      return user.restId;
    }
  } catch (e) {
    log("x_sentiment_warn", `Failed to resolve handle @${handle}: ${e.message}`);
    logSentiment({ event: "resolve_handle", handle, success: false, error: e.message });
  }
  return null;
}

/**
 * Search X posts for a contract address, filtered to trusted accounts.
 * Uses X's advanced search with from: operator.
 *
 * @param {string} mint - Token contract address
 * @param {string[]} handles - Trusted X handles to filter by
 * @param {number} lookbackDays - How many days back to search (max 7 for free/basic)
 * @returns {Promise<{posts: object[], total: number, from_trusted: number}>}
 */
export async function searchPostsByCA({ mint, handles = [], lookbackDays = 7 }) {
  const t0 = Date.now();
  const client = await getXClient();
  if (!client) return { posts: [], total: 0, from_trusted: 0, error: _cookieExpired ? "COOKIE_EXPIRED" : "NO_CLIENT" };

  // Build since date
  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // If no handles provided, load from file
  if (handles.length === 0) {
    const { accounts } = loadAccounts();
    handles = accounts.map((a) => a.handle);
  }
  if (handles.length === 0) {
    return { posts: [], total: 0, from_trusted: 0, error: "NO_TRUSTED_ACCOUNTS" };
  }

  // Resolve all handles to restIds (for author identification in search results)
  const restIdToHandle = new Map();
  await Promise.all(handles.map(async (h) => {
    const restId = await resolveHandle(client, h);
    if (restId) restIdToHandle.set(restId, h);
  }));

  // Batch handles in groups of 8 (X query length limit)
  const BATCH_SIZE = 8;
  const batches = [];
  for (let i = 0; i < handles.length; i += BATCH_SIZE) {
    batches.push(handles.slice(i, i + BATCH_SIZE));
  }

  const allPosts = new Map(); // dedupe by tweet id

  for (const batch of batches) {
    const fromClause = batch.map((h) => `from:${h}`).join(" OR ");
    const query = `"${mint}" (${fromClause}) since:${since} -is:retweet`;

    try {
      const result = await client.search(query, { type: "latest", count: 100 });
      for (const tweet of result.items || []) {
        if (!allPosts.has(tweet.id)) {
          allPosts.set(tweet.id, tweet);
        }
      }
    } catch (e) {
      const msg = e.message || String(e);
      if (msg.includes("authenticate") || msg.includes("401") || msg.includes("403")) {
        markCookieExpired(msg);
        return { posts: [], total: 0, from_trusted: 0, error: "COOKIE_EXPIRED" };
      }
      log("x_sentiment_warn", `Search failed for batch: ${msg}`);
    }
  }

  const posts = [...allPosts.values()];
  const duration_ms = Date.now() - t0;

  logSentiment({
    event: "search",
    mint,
    posts_found: posts.length,
    batches: batches.length,
    handles: handles.length,
    lookback_days: lookbackDays,
    duration_ms,
  });

  return {
    posts: posts.map((t) => {
      // Resolve author handle: try screenName from parsed result, then match restId
      const authorHandle = t.user?.screenName
        || restIdToHandle.get(t.user?.restId)
        || "unknown";
      return {
        id: t.id,
        text: t.text,
        createdAt: t.createdAt,
        author: authorHandle,
        authorName: _handleCache.get(authorHandle)?.name || t.user?.name || "",
        likes: t.likeCount || 0,
        retweets: t.retweetCount || 0,
        replies: t.replyCount || 0,
        url: `https://x.com/${authorHandle}/status/${t.id}`,
      };
    }),
    total: posts.length,
    from_trusted: posts.length,
  };
}

// ─── Sentiment Analysis ───────────────────────────────────────────

const NEGATIVE_KEYWORDS = [
  "scam", "rug", "rugpull", "rug pull", "honeypot", "honey pot",
  "dump", "dumped", "dumping", "dead", "avoid", "warning",
  "stay away", "rekt", "slow rug", "dev sold", "dev dumping",
  "insider", "insider trading", "bundled", "bundle",
  "ponzi", "exit scam", "liquidity pull", "liquidity removed",
  "don't buy", "dont buy", "not buying", "pass on this",
  "fake", "fraud", "steal", "stolen", "hack", "hacked",
  "shitcoin", "shit coin", "garbage", "trash", "worthless",
  "manipulated", "manipulation", "wash trade", "wash trading",
  "suspicious", "sketchy", "red flag", "red flags",
  "getting dumped", "about to dump", "will dump",
  "paper handed", "paper hands", "rotted",
];

const POSITIVE_KEYWORDS = [
  "bullish", "moon", "mooning", "gem", "alpha", "legit",
  "solid", "strong", "accumulating", "accumulation",
  "based", "send it", "undervalued", "sleeper",
  "breakout", "momentum", "opportunity", "conviction",
  "bought", "buying", "aped in", "aping", "long",
  "hold", "hodl", "diamond hands", "diamond hands",
  "early", "early entry", "generational",
  "community", "organic", "real", "genuine",
  "partner", "partnership", "listing", "listed",
  "catalyst", "announcement", "building", "builder",
  "growth", "growing", "trending", "popular",
];

function scorePost(text) {
  const lower = text.toLowerCase();
  let negHits = 0;
  let posHits = 0;

  for (const kw of NEGATIVE_KEYWORDS) {
    if (lower.includes(kw)) negHits++;
  }
  for (const kw of POSITIVE_KEYWORDS) {
    if (lower.includes(kw)) posHits++;
  }

  const total = negHits + posHits;
  if (total === 0) return 0; // neutral
  return (posHits - negHits) / total; // range [-1, 1]
}

/**
 * Analyze X sentiment for a token from trusted accounts.
 *
 * @param {string} mint - Token contract address
 * @param {number} lookbackDays - Days to look back (default 7)
 * @returns {Promise<object>} Sentiment result
 */
export async function analyzeSentiment({ mint, lookbackDays = null }) {
  const t0 = Date.now();
  const days = lookbackDays ?? config.xSentiment.lookbackDays ?? 7;

  // Check cache
  const cached = _sentimentCache.get(mint);
  if (cached && Date.now() - cached.fetchedAt < SENTIMENT_CACHE_TTL) {
    logSentiment({ event: "analyze", mint, sentiment: cached.result.sentiment, score: cached.result.score, post_count: cached.result.post_count, duration_ms: Date.now() - t0, from_cache: true });
    return cached.result;
  }

  // Load trusted accounts
  const { accounts } = loadAccounts();
  if (accounts.length === 0) {
    const result = { mint, sentiment: "NO_ACCOUNTS", score: 0, post_count: 0, summary: "No trusted X accounts configured" };
    _sentimentCache.set(mint, { result, fetchedAt: Date.now() });
    logSentiment({ event: "analyze", mint, sentiment: "NO_ACCOUNTS", score: 0, post_count: 0, duration_ms: Date.now() - t0, from_cache: false });
    return result;
  }

  // Search
  const searchResult = await searchPostsByCA({ mint, lookbackDays: days });

  if (searchResult.error === "COOKIE_EXPIRED") {
    logSentiment({ event: "analyze", mint, sentiment: "COOKIE_EXPIRED", score: 0, post_count: 0, duration_ms: Date.now() - t0, from_cache: false, error: "cookie_expired" });
    return { mint, sentiment: "COOKIE_EXPIRED", score: 0, post_count: 0, summary: "X cookies expired — refresh X_AUTH_TOKEN and X_CT0 in .env" };
  }
  if (searchResult.error === "NO_TRUSTED_ACCOUNTS") {
    logSentiment({ event: "analyze", mint, sentiment: "NO_ACCOUNTS", score: 0, post_count: 0, duration_ms: Date.now() - t0, from_cache: false, error: "no_accounts" });
    return { mint, sentiment: "NO_ACCOUNTS", score: 0, post_count: 0, summary: "No trusted X accounts configured" };
  }
  if (searchResult.error === "NO_CLIENT") {
    logSentiment({ event: "analyze", mint, sentiment: "DISABLED", score: 0, post_count: 0, duration_ms: Date.now() - t0, from_cache: false, error: "no_client" });
    return { mint, sentiment: "DISABLED", score: 0, post_count: 0, summary: "X sentiment not configured" };
  }

  const posts = searchResult.posts;
  if (posts.length === 0) {
    const result = { mint, sentiment: "NEUTRAL", score: 0, post_count: 0, negative_count: 0, positive_count: 0, neutral_count: 0, summary: "No posts found from trusted accounts", posts: [] };
    _sentimentCache.set(mint, { result, fetchedAt: Date.now() });
    logSentiment({ event: "analyze", mint, sentiment: "NEUTRAL", score: 0, post_count: 0, duration_ms: Date.now() - t0, from_cache: false });
    return result;
  }

  // Score each post
  let totalScore = 0;
  let negativeCount = 0;
  let positiveCount = 0;
  let neutralCount = 0;

  for (const post of posts) {
    const score = scorePost(post.text);
    post._score = score;
    totalScore += score;
    if (score < -0.1) negativeCount++;
    else if (score > 0.1) positiveCount++;
    else neutralCount++;
  }

  const avgScore = totalScore / posts.length; // [-1, 1]
  const normalizedScore = Math.round(avgScore * 100); // [-100, 100]

  let sentiment;
  if (normalizedScore <= -15) sentiment = "NEGATIVE";
  else if (normalizedScore >= 15) sentiment = "POSITIVE";
  else sentiment = "NEUTRAL";

  // Sort posts by absolute score (most opinionated first), take top 5
  const topPosts = [...posts]
    .sort((a, b) => Math.abs(b._score) - Math.abs(a._score))
    .slice(0, 5)
    .map((p) => ({
      text: p.text.slice(0, 200),
      author: `@${p.author}`,
      score: p._score > 0.1 ? "positive" : p._score < -0.1 ? "negative" : "neutral",
      url: p.url,
    }));

  const summary = `${sentiment} (${normalizedScore}) from ${posts.length} posts by ${accounts.length} trusted accounts (${positiveCount} pos, ${negativeCount} neg, ${neutralCount} neutral)`;

  const result = {
    mint,
    sentiment,
    score: normalizedScore,
    post_count: posts.length,
    negative_count: negativeCount,
    positive_count: positiveCount,
    neutral_count: neutralCount,
    summary,
    posts: topPosts,
  };

  _sentimentCache.set(mint, { result, fetchedAt: Date.now() });

  logSentiment({
    event: "analyze",
    mint,
    sentiment: result.sentiment,
    score: result.score,
    post_count: result.post_count,
    positive: result.positive_count,
    negative: result.negative_count,
    neutral: result.neutral_count,
    duration_ms: Date.now() - t0,
    from_cache: false,
  });

  return result;
}

// ─── Sentiment Cache (30 min TTL) ─────────────────────────────────

const SENTIMENT_CACHE_TTL = 30 * 60 * 1000;
const _sentimentCache = new Map();

/**
 * Clear the sentiment cache (e.g. after config change).
 */
export function clearSentimentCache() {
  _sentimentCache.clear();
}
