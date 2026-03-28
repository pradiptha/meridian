import { generateBriefing } from "../briefing.js";

async function testBriefing() {
  console.log("Testing generateBriefing()...\n");
  
  try {
    const briefing = await generateBriefing();
    console.log("Generated briefing:");
    console.log("=".repeat(40));
    console.log(briefing);
    console.log("=".repeat(40));
    
    // Verify it's a string and contains expected sections
    if (typeof briefing !== "string") {
      console.error("FAIL: briefing should be a string");
      process.exit(1);
    }
    
    const hasActivity = briefing.includes("Activity:");
    const hasPerformance = briefing.includes("Performance:");
    const hasLessons = briefing.includes("Lessons Learned:");
    const hasPortfolio = briefing.includes("Current Portfolio:");
    
    if (!hasActivity || !hasPerformance || !hasLessons || !hasPortfolio) {
      console.error("FAIL: briefing missing expected sections");
      process.exit(1);
    }
    
    console.log("\n✓ All tests passed!");
  } catch (err) {
    console.error("Test failed:", err.message);
    process.exit(1);
  }
}

testBriefing();