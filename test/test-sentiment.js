#!/usr/bin/env node

// Test script for X sentiment analysis
// Usage: node test-sentiment.js <mint_address> [lookback_days]

import "dotenv/config";
import { analyzeSentiment, searchPostsByCA, checkCookieHealth, listXAccounts } from "../tools/x.js";

const mint = process.argv[2] || "82MmG1uH2BWLyoU7VCFYMohP9CT63q5paiKHAAAn3zWx";
const days = parseInt(process.argv[3]) || 7;

console.log("═".repeat(60));
console.log(" X Sentiment Test");
console.log("═".repeat(60));
console.log(`Mint:      ${mint}`);
console.log(`Lookback:  ${days} days`);
console.log("");

// 1. Check cookie health
console.log("[1/4] Cookie health check...");
const health = await checkCookieHealth();
console.log(`  Result: ${health.healthy ? "✓ healthy" : "✗ " + health.reason}`);
if (!health.healthy) {
  console.log("  Cookies invalid — set X_AUTH_TOKEN and X_CT0 in .env");
  process.exit(1);
}
console.log("");

// 2. List trusted accounts
console.log("[2/4] Trusted accounts...");
const { total, accounts } = listXAccounts();
console.log(`  Count: ${total}`);
if (total === 0) {
  console.log("  No accounts — add with: node -e \"import('./tools/x.js').then(m => console.log(m.addXAccount({ handle: 'your_handle' })))\"");
  process.exit(1);
}
for (const a of accounts) {
  console.log(`  @${a.handle} (${a.category})`);
}
console.log("");

// 3. Raw search
console.log("[3/4] Searching X posts...");
const searchStart = Date.now();
const search = await searchPostsByCA({ mint, lookbackDays: days });
const searchMs = Date.now() - searchStart;
console.log(`  Found: ${search.total} posts (${searchMs}ms)`);
if (search.error) console.log(`  Error: ${search.error}`);
for (const p of search.posts || []) {
  console.log(`  ┌ @${p.author}: ${p.text.slice(0, 80).replace(/\n/g, " ")}...`);
}
console.log("");

// 4. Sentiment analysis
console.log("[4/4] Sentiment analysis...");
const sentStart = Date.now();
const result = await analyzeSentiment({ mint, lookbackDays: days });
const sentMs = Date.now() - sentStart;
console.log(`  Sentiment: ${result.sentiment} (${result.score})`);
console.log(`  Posts:     ${result.post_count} (${result.positive_count} pos, ${result.negative_count} neg, ${result.neutral_count} neutral)`);
console.log(`  Summary:   ${result.summary}`);
console.log(`  Time:      ${sentMs}ms`);
console.log("");

if (result.posts?.length > 0) {
  console.log("Top posts:");
  for (const p of result.posts) {
    console.log(`  [${p.score.padEnd(8)}] ${p.author}: ${p.text.slice(0, 120).replace(/\n/g, " ")}`);
  }
  console.log("");
}

console.log("═".repeat(60));
console.log(" Done");
