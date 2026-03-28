import { repairPerformanceData } from "../tools/repair.js";

async function testRepair() {
  console.log("Testing repairPerformanceData()...\n");
  console.log("=== DRY RUN FIRST ===\n");
  
  try {
    // Dry run first to see what would change
    const result = await repairPerformanceData({ dryRun: true });
    console.log("\nResult:", result);
    
    if (result.updated > 0) {
      console.log(`\n=== APPLYING REPAIRS (${result.updated} entries) ===\n`);
      const applyResult = await repairPerformanceData({ dryRun: false });
      console.log("Apply result:", applyResult);
    } else {
      console.log("\n✓ No repairs needed");
    }
  } catch (err) {
    console.error("Test failed:", err.message);
    process.exit(1);
  }
}

testRepair();