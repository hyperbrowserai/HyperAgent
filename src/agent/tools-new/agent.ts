/**
 * New Tool-Based Agent Implementation
 * Uses AI SDK's generateText with tool calling instead of custom JSON loop
 * Based on Stagehand's proven architecture
 */

import { generateText, stepCountIs } from 'ai';
import { createAgentTools, ToolContext } from './index';
import { TaskState, TaskStatus, TaskParams, TaskOutput } from '@hyperbrowser/agent/types';
import { AgentCtx } from '../tools/types';
import { HyperagentError } from '../error';
import { sleep } from '@/utils/sleep';
import fs from 'fs';

const DATE_STRING = new Date().toLocaleString(undefined, {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  weekday: 'long',
});

/**
 * Build system prompt for tool-based agent
 * Much simpler than old prompt - tools describe themselves
 */
function buildSystemPrompt(task: string): string {
  return `You are a web automation assistant. Your goal is to accomplish the user's task by using the available tools.

Today's date: ${DATE_STRING}

Your task: ${task}

IMPORTANT GUIDELINES:
1. Start by calling getDOM to understand the current page structure
2. Use act tool to perform actions described in natural language (e.g., "click the login button")
3. Take ONE action at a time and verify the result
4. When the task is complete (or impossible), call complete with success status
5. If you can't find an element, try scrolling or call complete with explanation

STRATEGY:
- Call getDOM first to see what's on the page
- Use act with clear natural language descriptions
- Verify outcomes before proceeding
- Call complete when done

The tools will handle finding elements and executing actions. Just describe what you want to do in natural language.`;
}

/**
 * Run agent task using AI SDK tool-based architecture
 * Replaces the old custom JSON loop with AI SDK's generateText
 */
export async function runAgentTask(
  ctx: AgentCtx,
  taskState: TaskState,
  params?: TaskParams
): Promise<TaskOutput> {
  const taskId = taskState.id;
  const debugDir = params?.debugDir || `debug/${taskId}`;

  if (ctx.debug) {
    console.log(`[Agent] Starting task ${taskId} in ${debugDir}`);
    fs.mkdirSync(debugDir, { recursive: true });
  }

  if (!taskState) {
    throw new HyperagentError(`Task ${taskId} not found`);
  }

  taskState.status = TaskStatus.RUNNING;

  if (!ctx.llm) {
    throw new HyperagentError('LLM not initialized');
  }

  const page = taskState.startingPage;
  const task = taskState.task;

  // Create tool context (shared state between tools)
  const toolContext: ToolContext = {
    page,
    llm: ctx.llm,
    logger: ctx.debug ? (msg: string, data?: any) => {
      console.log(`[Tool] ${msg}`, data || '');
    } : undefined,
    currentTree: undefined,
    currentXpathMap: undefined,
    currentElements: undefined,
    taskCompleted: false,
    taskSuccess: false,
    taskOutput: undefined,
  };

  // Create tools with shared context
  const tools = createAgentTools(toolContext);

  const systemPrompt = buildSystemPrompt(task);
  const maxSteps = params?.maxSteps || 10;

  if (ctx.debug) {
    fs.writeFileSync(
      `${debugDir}/system-prompt.txt`,
      systemPrompt
    );
  }

  try {
    // Check if LLM has getLanguageModel (AI SDK integration)
    if (!('getLanguageModel' in ctx.llm)) {
      throw new HyperagentError(
        'Current LLM does not support AI SDK integration. ' +
        'Please use an AI SDK-compatible model (e.g., openai/gpt-4o).'
      );
    }

    const languageModel = (ctx.llm as any).getLanguageModel();

    if (ctx.debug) {
      console.log(`[Agent] Using model: ${ctx.llm.getModelId()}`);
      console.log(`[Agent] Max steps: ${maxSteps}`);
      console.log(`[Agent] Tools: ${Object.keys(tools).join(', ')}`);
    }

    // Use AI SDK's generateText with tools
    // Note: Type cast needed due to TypeScript inference issues with closure-based tools
    const result = await generateText({
      model: languageModel,
      system: systemPrompt,
      prompt: task,
      tools: tools as any,
      stopWhen: stepCountIs(maxSteps),
      temperature: 0.7,
      toolChoice: 'auto',
      onStepFinish: async (event) => {
        // Log tool calls
        if (event.toolCalls && event.toolCalls.length > 0) {
          for (const toolCall of event.toolCalls) {
            if (ctx.debug) {
              console.log(`[Agent] Tool called: ${toolCall.toolName}`);
              console.log(`[Agent] Arguments:`, toolCall.input);
            }

            // Check if task is completed
            if (toolCall.toolName === 'complete') {
              toolContext.taskCompleted = true;
            }
          }
        }

        // Log reasoning
        if (event.text && ctx.debug) {
          console.log(`[Agent] Reasoning: ${event.text}`);
        }

        // Status checks
        if (taskState.status === TaskStatus.PAUSED) {
          await sleep(100);
        }
      },
    });

    // Get final output
    const output = toolContext.taskOutput || result.text || 'Task completed';
    const success = toolContext.taskSuccess || false;

    // Set final status
    if (toolContext.taskCompleted) {
      taskState.status = success ? TaskStatus.COMPLETED : TaskStatus.FAILED;
    } else {
      // Ran out of steps without completing
      taskState.status = TaskStatus.FAILED;
    }

    if (ctx.debug) {
      console.log(`[Agent] Task finished: ${taskState.status}`);
      console.log(`[Agent] Output: ${output}`);
      fs.writeFileSync(
        `${debugDir}/result.json`,
        JSON.stringify({
          status: taskState.status,
          output,
          usage: result.usage,
          steps: result.steps?.length || 0,
        }, null, 2)
      );
    }

    const taskOutput: TaskOutput = {
      status: taskState.status,
      steps: taskState.steps,
      output,
    };

    await params?.onComplete?.(taskOutput);
    return taskOutput;

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);

    if (ctx.debug) {
      console.error(`[Agent] Error: ${errorMsg}`);
    }

    taskState.status = TaskStatus.FAILED;
    taskState.error = errorMsg;

    const taskOutput: TaskOutput = {
      status: TaskStatus.FAILED,
      steps: taskState.steps,
      output: `Failed: ${errorMsg}`,
    };

    await params?.onComplete?.(taskOutput);
    return taskOutput;
  }
}
