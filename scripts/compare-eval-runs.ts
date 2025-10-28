import fs from "fs";
import path from "path";
import chalk from "chalk";

interface EvalResult {
  id: string;
  status: "PASSED" | "FAILED";
  question: string;
  actual?: string;
  expected?: string;
  reason?: string | null;
  evaluationReason?: string | null;
  notes?: string | null;
}

interface EvalSummary {
  totalEvaluations: number;
  correctEvaluations: number;
  failedEvaluations: number;
  successRate: number;
  detailedResults: EvalResult[];
}

interface ComparisonMetrics {
  baseline: {
    successRate: number;
    totalTasks: number;
    passedTasks: number;
    failedTasks: number;
  };
  phase1: {
    successRate: number;
    totalTasks: number;
    passedTasks: number;
    failedTasks: number;
  };
  delta: {
    successRateDelta: number;
    newlyPassed: string[];
    newlyFailed: string[];
    stillPassing: string[];
    stillFailing: string[];
  };
}

function loadSummary(summaryPath: string): EvalSummary {
  if (!fs.existsSync(summaryPath)) {
    throw new Error(`Summary file not found: ${summaryPath}`);
  }
  const content = fs.readFileSync(summaryPath, "utf-8");
  return JSON.parse(content) as EvalSummary;
}

function compareResults(
  baseline: EvalSummary,
  phase1: EvalSummary
): ComparisonMetrics {
  const baselinePassedIds = new Set(
    baseline.detailedResults
      .filter((r) => r.status === "PASSED")
      .map((r) => r.id)
  );
  const phase1PassedIds = new Set(
    phase1.detailedResults.filter((r) => r.status === "PASSED").map((r) => r.id)
  );

  const allIds = new Set([
    ...baseline.detailedResults.map((r) => r.id),
    ...phase1.detailedResults.map((r) => r.id),
  ]);

  const newlyPassed: string[] = [];
  const newlyFailed: string[] = [];
  const stillPassing: string[] = [];
  const stillFailing: string[] = [];

  for (const id of allIds) {
    const baselinePassed = baselinePassedIds.has(id);
    const phase1Passed = phase1PassedIds.has(id);

    if (!baselinePassed && phase1Passed) {
      newlyPassed.push(id);
    } else if (baselinePassed && !phase1Passed) {
      newlyFailed.push(id);
    } else if (baselinePassed && phase1Passed) {
      stillPassing.push(id);
    } else {
      stillFailing.push(id);
    }
  }

  return {
    baseline: {
      successRate: baseline.successRate,
      totalTasks: baseline.totalEvaluations,
      passedTasks: baseline.correctEvaluations,
      failedTasks: baseline.failedEvaluations,
    },
    phase1: {
      successRate: phase1.successRate,
      totalTasks: phase1.totalEvaluations,
      passedTasks: phase1.correctEvaluations,
      failedTasks: phase1.failedEvaluations,
    },
    delta: {
      successRateDelta: phase1.successRate - baseline.successRate,
      newlyPassed,
      newlyFailed,
      stillPassing,
      stillFailing,
    },
  };
}

function printComparisonReport(metrics: ComparisonMetrics): void {
  console.log("\n" + chalk.cyan.bold("=".repeat(80)));
  console.log(chalk.cyan.bold("               EVAL COMPARISON REPORT"));
  console.log(chalk.cyan.bold("=".repeat(80)) + "\n");

  // Baseline metrics
  console.log(chalk.yellow.bold("📊 BASELINE (Current Implementation)"));
  console.log(
    `   Total Tasks:    ${metrics.baseline.totalTasks}`
  );
  console.log(
    `   Passed:         ${chalk.green(metrics.baseline.passedTasks)}`
  );
  console.log(
    `   Failed:         ${chalk.red(metrics.baseline.failedTasks)}`
  );
  console.log(
    `   Success Rate:   ${chalk.yellow(metrics.baseline.successRate + "%")}\n`
  );

  // Phase 1 metrics
  console.log(chalk.blue.bold("🚀 PHASE 1 (Accessibility Tree Implementation)"));
  console.log(
    `   Total Tasks:    ${metrics.phase1.totalTasks}`
  );
  console.log(
    `   Passed:         ${chalk.green(metrics.phase1.passedTasks)}`
  );
  console.log(
    `   Failed:         ${chalk.red(metrics.phase1.failedTasks)}`
  );
  console.log(
    `   Success Rate:   ${chalk.blue(metrics.phase1.successRate + "%")}\n`
  );

  // Delta analysis
  console.log(chalk.magenta.bold("📈 DELTA ANALYSIS"));
  const deltaColor =
    metrics.delta.successRateDelta > 0
      ? chalk.green
      : metrics.delta.successRateDelta < 0
        ? chalk.red
        : chalk.gray;
  const deltaSymbol = metrics.delta.successRateDelta > 0 ? "↑" : "↓";
  console.log(
    `   Success Rate Change:  ${deltaColor(
      (metrics.delta.successRateDelta > 0 ? "+" : "") +
        metrics.delta.successRateDelta +
        "% " +
        deltaSymbol
    )}`
  );
  console.log(
    `   Newly Passed:         ${chalk.green(metrics.delta.newlyPassed.length)}`
  );
  console.log(
    `   Newly Failed:         ${chalk.red(metrics.delta.newlyFailed.length)}`
  );
  console.log(
    `   Still Passing:        ${chalk.gray(metrics.delta.stillPassing.length)}`
  );
  console.log(
    `   Still Failing:        ${chalk.gray(metrics.delta.stillFailing.length)}\n`
  );

  // Detailed breakdowns
  if (metrics.delta.newlyPassed.length > 0) {
    console.log(chalk.green.bold("✅ NEWLY PASSED TASKS"));
    metrics.delta.newlyPassed.forEach((id) => {
      console.log(`   ${chalk.green("✓")} ${id}`);
    });
    console.log();
  }

  if (metrics.delta.newlyFailed.length > 0) {
    console.log(chalk.red.bold("❌ NEWLY FAILED TASKS (Regressions)"));
    metrics.delta.newlyFailed.forEach((id) => {
      console.log(`   ${chalk.red("✗")} ${id}`);
    });
    console.log();
  }

  // Summary verdict
  console.log(chalk.cyan.bold("=".repeat(80)));
  console.log(chalk.cyan.bold("               VERDICT"));
  console.log(chalk.cyan.bold("=".repeat(80)) + "\n");

  if (metrics.delta.successRateDelta > 0) {
    console.log(
      chalk.green.bold(
        `✨ Phase 1 is ${Math.abs(metrics.delta.successRateDelta)}% MORE accurate than baseline!`
      )
    );
  } else if (metrics.delta.successRateDelta < 0) {
    console.log(
      chalk.red.bold(
        `⚠️  Phase 1 is ${Math.abs(metrics.delta.successRateDelta)}% LESS accurate than baseline`
      )
    );
  } else {
    console.log(chalk.gray.bold("➖ Phase 1 has the SAME accuracy as baseline"));
  }

  const netImprovement =
    metrics.delta.newlyPassed.length - metrics.delta.newlyFailed.length;
  if (netImprovement > 0) {
    console.log(
      chalk.green(
        `   Net improvement: ${netImprovement} more tasks passing overall`
      )
    );
  } else if (netImprovement < 0) {
    console.log(
      chalk.red(
        `   Net regression: ${Math.abs(netImprovement)} fewer tasks passing overall`
      )
    );
  }

  console.log("\n" + chalk.cyan.bold("=".repeat(80)) + "\n");
}

function saveComparisonReport(
  metrics: ComparisonMetrics,
  outputPath: string
): void {
  const report = {
    timestamp: new Date().toISOString(),
    baseline: metrics.baseline,
    phase1: metrics.phase1,
    delta: metrics.delta,
  };

  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
  console.log(chalk.gray(`\n📄 Detailed report saved to: ${outputPath}\n`));
}

// Main execution
(async () => {
  const baselinePath = process.argv[2];
  const phase1Path = process.argv[3];

  if (!baselinePath || !phase1Path) {
    console.error(
      chalk.red(
        "Usage: yarn ts-node scripts/compare-eval-runs.ts <baseline-summary.json> <phase1-summary.json>"
      )
    );
    console.error(
      chalk.gray(
        "\nExample: yarn ts-node scripts/compare-eval-runs.ts logs/2024-10-28/summary.json logs/2024-10-29/summary.json"
      )
    );
    process.exit(1);
  }

  try {
    const baseline = loadSummary(baselinePath);
    const phase1 = loadSummary(phase1Path);

    const metrics = compareResults(baseline, phase1);
    printComparisonReport(metrics);

    // Save detailed comparison report
    const outputDir = path.dirname(phase1Path);
    const outputPath = path.join(outputDir, "comparison-report.json");
    saveComparisonReport(metrics, outputPath);
  } catch (error) {
    console.error(chalk.red("Error comparing eval runs:"), error);
    process.exit(1);
  }
})();
