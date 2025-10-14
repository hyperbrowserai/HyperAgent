import { HyperAgent } from "../src/agent";
import { createLLMClient } from "../src/llm/providers";
import dotenv from "dotenv";
import chalk from "chalk";
import fs from "fs";
import path from "path";
import { sleep } from "../src/utils/sleep";
import { retry } from "../src/utils/retry";
import { z } from "zod";
import { minimatch } from "minimatch";

dotenv.config();

class Logger {
  private logStream: fs.WriteStream;
  private logToConsole: boolean;

  constructor(runId: string, evalId: string, logToConsole = false) {
    const logDir = path.join(__dirname, `../logs/${runId}/${evalId}`);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const logPath = path.join(logDir, `webvoyager-eval.log`);
    this.logStream = fs.createWriteStream(logPath, { flags: "a" });
    this.logToConsole = logToConsole;
    this.log(`Log started at ${new Date().toISOString()}\n`);
  }

  log(message: string, type: "info" | "error" | "success" = "info") {
    this.logStream.write(message);
    if (this.logToConsole) {
      switch (type) {
        case "error":
          console.error(chalk.red(message));
          break;
        case "success":
          console.log(chalk.green(message));
          break;
        default:
          console.log(message);
      }
    }
  }

  logObject(obj: any, prefix = "") {
    const objString = JSON.stringify(obj, null, 2);
    this.log(`${prefix}${objString}`);
  }

  close() {
    this.logStream.end();
  }
}

interface WebVoyagerEval {
  web_name: string;
  id: string;
  ques: string;
  web: string;
}

interface ReferenceAnswer {
  id: number;
  type: string;
  ans: string;
  notes?: string;
}

interface WebsiteReference {
  notice?: string;
  answers: ReferenceAnswer[];
}

interface References {
  [website: string]: WebsiteReference;
}

interface EvalResult {
  id: string;
  correct: boolean;
  question: string;
  actual?: string;
  expected?: string;
  reason?: string;
  evaluationReason?: string;
  notes?: string;
}

const AnswerEvaluationSchema = z.object({
  isCorrect: z
    .boolean()
    .describe(
      "Whether the generated answer is correct compared to the reference"
    ),
  reason: z.string().describe("Reason for the evaluation"),
});

type AnswerEvaluation = z.infer<typeof AnswerEvaluationSchema>;

async function loadEvals() {
  const evalPath = path.join(__dirname, "../evals/WebVoyager_data.jsonl");
  const fileContent = await fs.promises.readFile(evalPath, "utf-8");
  const lines = fileContent.split("\n");
  const result: WebVoyagerEval[] = [];
  for (const line of lines) {
    const eval_data = JSON.parse(line) as WebVoyagerEval;
    if (line.trim()) {
      result.push(eval_data);
    }
  }
  return result;
}

async function loadReferences(): Promise<References> {
  const refPath = path.join(__dirname, "../evals/WebVoyager_reference.json");
  const fileContent = await fs.promises.readFile(refPath, "utf-8");
  return JSON.parse(fileContent);
}

async function checkAnswerAgainstReference(
  answer: string,
  reference: string,
  question: string,
  screenshotPath: string,
  notes?: string
): Promise<AnswerEvaluation> {
  const screenshotBase64 = fs.readFileSync(screenshotPath, {
    encoding: "base64",
  });
  const imageUrl = `data:image/png;base64,${screenshotBase64}`;

  const messages = [
    {
      role: "system" as const,
      content:
        "You are an evaluator checking if a web navigation agent correctly answered a question. Your task is to verify the agent's answer by examining the final webpage screenshot and comparing it to a reference answer. Focus primarily on the visual evidence in the screenshot rather than just comparing text answers.",
    },
    {
      role: "user" as const,
      content: [
        {
          type: "text" as const,
          text: `Question: ${question}

Reference Answer: ${reference}

Generated Answer: ${answer}

${notes ? `Additional Notes: ${notes}` : ""}

Please evaluate if the generated answer is correct by:
1. Primarily using the screenshot to verify the information
2. Checking if key information matches between the reference and generated answer
3. Being somewhat lenient - if the main points are correct, minor differences in exact numbers or formatting are acceptable (especially stuff like ratings and reviews which may update over time)

Respond in JSON format with { isCorrect: true | false, reason: string }`,
        },
        {
          type: "image" as const,
          url: imageUrl,
          mimeType: "image/png",
        },
      ],
    },
  ];

  const llm = createLLMClient({
    provider: "openai",
    model: "gpt-4o",
  });

  const result = await llm.invokeStructured(
    {
      schema: AnswerEvaluationSchema,
    },
    messages
  );

  if (!result.parsed) {
    throw new Error("Failed to get structured output from LLM");
  }

  return result.parsed;
}

async function runEvalHelper(
  agent: HyperAgent,
  eval_data: WebVoyagerEval,
  references: References,
  logger: Logger,
  runId: string
): Promise<EvalResult> {
  logger.log("\n===== Running Eval =====");
  logger.log(`\nID: ${eval_data.id}`);
  logger.log(`\nWebsite: ${eval_data.web_name}`);
  logger.log(`\nQuestion: ${eval_data.ques}`);
  logger.log("\n=======================\n");

  const page = await agent.getCurrentPage();
  await page.goto(eval_data.web, {
    waitUntil: "domcontentloaded",
  });
  await sleep(1000);
  await page.reload({ waitUntil: "domcontentloaded" });
  await sleep(1000);

  const result = await agent.executeTask(eval_data.ques, {
    maxSteps: 25,
    debugDir: path.join(__dirname, `../logs/${runId}/${eval_data.id}/debug`),
    debugOnAgentOutput: (agentOutput) => {
      logger.log("\n===== AGENT OUTPUT =====");
      logger.logObject(agentOutput);
      logger.log("===============\n");
    },
    onStep: (step) => {
      logger.log(`\n===== STEP ${step.idx} =====`);
      logger.logObject(step);
      logger.log("===============\n");
    },
  });
  if (!result.output) {
    throw new Error("No output from agent");
  }

  logger.log(result.output || "");

  // Take screenshot of final state
  const screenshotPath = path.join(
    __dirname,
    `../logs/${runId}/${eval_data.id}/final-state.png`
  );
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await agent.closeAgent();

  // Check against reference
  const websiteRefs = references[eval_data.web_name];
  if (!websiteRefs) {
    logger.log("No references found for this website", "error");
    return {
      id: eval_data.id,
      question: eval_data.ques,
      correct: false,
      reason: "No references found for this website",
    };
  }
  const relevantRef =
    websiteRefs.answers[parseInt(eval_data.id.split("--")[1])];
  if (!relevantRef?.ans) {
    logger.log("No reference found for this specific evaluation ID", "error");
    return {
      id: eval_data.id,
      question: eval_data.ques,
      correct: false,
      reason: "No reference found for this specific evaluation ID",
    };
  }

  logger.log("\nChecking against reference...");
  try {
    const evaluation = await checkAnswerAgainstReference(
      result.output,
      relevantRef.ans,
      eval_data.ques,
      screenshotPath,
      relevantRef.notes
    );
    logger.log(
      evaluation.isCorrect ? "✓ CORRECT" : "✗ INCORRECT",
      evaluation.isCorrect ? "success" : "error"
    );
    return {
      id: eval_data.id,
      question: eval_data.ques,
      correct: evaluation.isCorrect,
      evaluationReason: evaluation.reason,
      actual: result.output,
      expected: relevantRef.ans,
      notes: relevantRef.notes,
    };
  } catch (error) {
    logger.log(`Error checking answer against reference: ${error}`, "error");
    return {
      id: eval_data.id,
      question: eval_data.ques,
      correct: false,
      actual: result.output,
      expected: relevantRef.ans,
      reason: `Error checking answer against reference: ${error}`,
    };
  }
}

const runEval = async (
  eval_data: WebVoyagerEval,
  references: References,
  runId: string
): Promise<EvalResult> => {
  const logger = new Logger(runId, eval_data.id);
  const agent = new HyperAgent({
    llm: {
      provider: "openai",
      model: "gpt-4o",
    },
    hyperbrowserConfig: {
      sessionConfig: {
        screen: { width: 1500, height: 1500 },
      },
    },
    debug: true,
  });
  try {
    const timeoutPromise = new Promise<EvalResult>((_, reject) => {
      setTimeout(
        () => reject(new Error("Evaluation timed out after 10 minutes")),
        10 * 60 * 1000
      );
    });
    return await Promise.race([
      retry({
        func: async () =>
          runEvalHelper(agent, eval_data, references, logger, runId),
        params: { retryCount: 3 },
      }),
      timeoutPromise,
    ]);
  } catch (error) {
    await agent.closeAgent();
    logger.log(`Error: ${error}`, "error");
    return {
      id: eval_data.id,
      question: eval_data.ques,
      correct: false,
      reason: `Error: ${error}`,
    };
  } finally {
    logger.close();
  }
};

async function runEvalsBatch(
  evals: WebVoyagerEval[],
  references: References,
  runId: string,
  concurrency: number = 25
): Promise<EvalResult[]> {
  const results: EvalResult[] = [];
  const queue = [...evals];
  const inProgress = new Set<Promise<EvalResult>>();

  // Helper to run a single eval and maintain the queue
  const runNext = async () => {
    if (queue.length === 0) return;
    const eval_data = queue.shift()!;
    const promise = runEval(eval_data, references, runId);
    inProgress.add(promise);

    promise
      .then((result) => {
        results.push(result);
        inProgress.delete(promise);
        // Start next eval if there are more in queue
        if (queue.length > 0) {
          runNext();
        }
      })
      .catch((error) => {
        console.error(`Error in evaluation ${eval_data.id}:`, error);
        inProgress.delete(promise);
        // Even on error, try to keep the pool full
        if (queue.length > 0) {
          runNext();
        }
      });
  };

  // Initialize the pool with concurrent evaluations
  const initialCount = Math.min(concurrency, queue.length);
  for (let i = 0; i < initialCount; i++) {
    await runNext();
  }

  // Wait for all evaluations to complete
  while (inProgress.size > 0) {
    await Promise.race([...inProgress]);
  }

  return results;
}

(async () => {
  let evals = await loadEvals();
  const references = await loadReferences();
  const targetId = process.argv[2];
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const logDir = path.join(__dirname, `../logs/${runId}`);
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  if (targetId) {
    evals = evals.filter((e) => minimatch(e.id, targetId));
    if (evals.length === 0) {
      console.log(
        chalk.red(`No evals found matching glob pattern: ${targetId}`)
      );
      process.exit(1);
    }
  }

  console.log(chalk.cyan(`Running ${evals.length} evaluations in parallel...`));
  const results = await runEvalsBatch(evals, references, runId);

  const totalEvals = results.length;
  const correctEvals = results.filter((r) => r.correct).length;

  const summary = {
    totalEvaluations: totalEvals,
    correctEvaluations: correctEvals,
    failedEvaluations: totalEvals - correctEvals,
    successRate: Math.round((correctEvals / totalEvals) * 100),
    detailedResults: results.map((result) => ({
      id: result.id,
      status: result.correct ? "PASSED" : "FAILED",
      question: result.question,
      actual: result.actual,
      expected: result.expected,
      reason: result.reason || null,
      evaluationReason: result.evaluationReason || null,
      notes: result.notes || null,
    })),
  };
  const summaryPath = path.join(logDir, "summary.json");
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

  // Also log to console for visibility
  console.log(chalk.cyan("Evaluation results:"));
  console.log(chalk.white(`Total evaluations: ${totalEvals}`));
  console.log(
    chalk.green(
      `Correct: ${correctEvals} (${Math.round((correctEvals / totalEvals) * 100)}%)`
    )
  );
  console.log(chalk.red(`Failed: ${totalEvals - correctEvals}`));
  console.log(chalk.white("\nDetailed results:"));
  results.forEach((result) => {
    console.log(
      `${result.correct ? chalk.green("✓ PASSED") : chalk.red("✗ FAILED")} Eval ID: ${result.id}${
        result.reason ? "\n  " + chalk.red(result.reason) : ""
      }`
    );
  });
  console.log(chalk.green("\nAll evaluations completed!"));
})().catch((error) => {
  console.error(chalk.red("Error running evaluations:"), error);
  process.exit(1);
});
