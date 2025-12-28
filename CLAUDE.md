# Claude Code Context

> This file provides context for Claude Code and other AI coding assistants.
> For detailed developer guidelines, see AGENTS.md.

## Quick Reference

```bash
# Build & Test (run these before committing)
yarn build          # Compile TypeScript to dist/
yarn test           # Run Jest tests
yarn lint           # ESLint check
yarn format         # Auto-format with Prettier
yarn typecheck      # Type-check without emitting

# Development
yarn cli -c "task description" [--debug] [--hyperbrowser]
yarn example examples/simple/add-to-amazon-cart.ts

# Validation (run all checks)
yarn validate       # lint + typecheck + test
```

## Project Overview

HyperAgent is an LLM-powered browser automation library built on Playwright. It provides:
- `page.ai(task)` - Execute complex browser tasks via natural language
- `page.extract(schema)` - Extract structured data from pages
- CDP-first action execution with Playwright fallback
- Multi-LLM support (OpenAI, Anthropic, Gemini, DeepSeek)

## Architecture at a Glance

```
src/
├── agent/              # Core orchestration
│   ├── actions/        # Built-in actions (navigate, click, scroll, etc.)
│   ├── tools/          # Agent runtime loop (agent.ts is the heart)
│   ├── messages/       # Prompt construction
│   ├── examine-dom/    # Single-action page.aiAction flow
│   ├── mcp/            # Model Context Protocol client
│   └── shared/         # DOM capture, caching, runtime context
├── cdp/                # Chrome DevTools Protocol wrapper
├── context-providers/  # DOM/a11y tree extraction
├── browser-providers/  # Local Playwright & Hyperbrowser cloud
├── llm/providers/      # LLM adapters (openai, anthropic, gemini, deepseek)
├── types/              # All TypeScript interfaces
├── utils/              # Shared helpers
└── cli/                # CLI entrypoint
```

## Key Files to Know

| File | Purpose |
|------|---------|
| `src/agent/tools/agent.ts` | Main agent loop - understand this first |
| `src/agent/actions/index.ts` | All built-in actions defined here |
| `src/context-providers/a11y-dom/` | DOM extraction via accessibility tree |
| `src/cdp/interactions.ts` | CDP action dispatch (click, input, etc.) |
| `src/types/config.ts` | HyperAgentConfig interface |
| `src/llm/providers/index.ts` | LLM client factory |

## Critical Patterns

### Element IDs
Elements use encoded IDs: `{frameIndex}-{backendNodeId}` (e.g., `0-123`)
- Managed by `context-providers/a11y-dom/build-maps.ts`
- Resolved via `cdp/element-resolver.ts`

### Action Execution Flow
1. Capture DOM state → `captureDOMState()`
2. Build messages → `agent/messages/`
3. LLM returns action → Zod-validated schema
4. Execute via CDP → `cdp/interactions.ts`
5. Fallback to Playwright if CDP fails

### Reserved Names
- `complete` action type is reserved (injected by runtime)
- Don't manually register it via `customActions`

## Code Style Requirements

- **Strict TypeScript**: No `any`, explicit return types, use interfaces from `src/types/`
- **Imports**: Use `@/*` path aliases (e.g., `@/agent/tools/agent`)
- **Formatting**: Prettier handles it - just run `yarn format`
- **Validation**: Use Zod schemas for LLM output and user input

## Testing Strategy

```bash
# Unit tests - place alongside code or in src/__tests__/
yarn test

# Integration probes - for browser/agent flows
yarn example scripts/test-page-ai.ts
yarn example scripts/test-async.ts

# Benchmark evaluation
yarn example scripts/run-webvoyager-eval.ts
```

## Common Tasks

### Adding a New Action
1. Create file in `src/agent/actions/`
2. Export from `src/agent/actions/index.ts`
3. Add Zod schema for parameters
4. Wire into agent loop if needed

### Adding a New LLM Provider
1. Create adapter in `src/llm/providers/`
2. Implement the LLMClient interface
3. Export from `src/llm/providers/index.ts`
4. Update `createLLMClient()` factory

### Modifying DOM Extraction
1. Changes go in `src/context-providers/a11y-dom/`
2. Keep `build-maps.ts` and `visual-overlay.ts` aligned
3. Test with `scripts/test-page-ai.ts`

## Anti-Patterns to Avoid

1. **Don't bypass CDP**: Use `cdp/` helpers, not raw Playwright for actions
2. **Don't hardcode frame indices**: Use the frame graph from `cdp/frame-context-manager.ts`
3. **Don't edit dist/**: Modify source in `src/`, run `yarn build`
4. **Don't hand-edit evals/**: Generated baselines, not source of truth
5. **Don't suppress ESLint**: Fix the issue instead
6. **Don't use relative imports**: Use `@/*` aliases

## Environment Variables

```bash
# Required for LLM providers (set at least one)
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GEMINI_API_KEY=...
DEEPSEEK_API_KEY=...

# Optional
HYPERBROWSER_API_KEY=...  # For cloud browser provider
DEBUG=true                 # Enable debug artifacts in debug/
```

## Before Committing

1. `yarn validate` (or manually: `yarn lint && yarn typecheck && yarn test`)
2. Ensure no `any` types introduced
3. Add tests for new behavior
4. Update AGENTS.md if adding architectural patterns

## Debugging Tips

- Pass `debug: true` to HyperAgent constructor
- Artifacts saved to `debug/<taskId>/`
- Use `--debug` flag with CLI
- Check CDP session logs for action failures

## Links

- [AGENTS.md](./AGENTS.md) - Detailed developer guidelines
- [currentState.md](./currentState.md) - Architectural documentation
- [docs/cdp-overview.md](./docs/cdp-overview.md) - CDP internals
