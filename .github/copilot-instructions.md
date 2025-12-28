# GitHub Copilot Instructions for HyperAgent

## Project Context

HyperAgent is an LLM-powered browser automation library built on Playwright.
Read CLAUDE.md for comprehensive context.

## Quick Commands

```bash
yarn build      # Compile TypeScript
yarn test       # Run Jest tests
yarn lint       # ESLint check
yarn validate   # All checks (lint + typecheck + test)
```

## Code Generation Rules

1. **TypeScript Strict Mode**: No `any` types. Use interfaces from `src/types/`.
2. **Imports**: Use `@/*` path aliases (e.g., `import { X } from "@/agent/tools/agent"`)
3. **Validation**: Use Zod schemas for LLM output parsing
4. **Error Handling**: Throw typed errors from `src/agent/error.ts`

## Architecture Patterns

- Agent loop: `src/agent/tools/agent.ts`
- Actions: `src/agent/actions/` - add new actions here
- DOM extraction: `src/context-providers/a11y-dom/`
- CDP interactions: `src/cdp/interactions.ts`

## Common Completions

### New Action Template

```typescript
import { z } from "zod";
import { ActionDefinition } from "@/types/actions";

export const myActionSchema = z.object({
  type: z.literal("myAction"),
  // parameters...
});

export const myAction: ActionDefinition = {
  name: "myAction",
  description: "Description for LLM",
  schema: myActionSchema,
  execute: async (params, context) => {
    // Implementation
  },
};
```

### Test Template

```typescript
import { describe, it, expect, jest } from "@jest/globals";

describe("MyFeature", () => {
  it("should do something", async () => {
    // Arrange
    // Act
    // Assert
  });
});
```

## Anti-patterns to Avoid

- Don't use relative imports (use @/* aliases)
- Don't bypass CDP helpers
- Don't suppress ESLint rules
- Don't edit dist/ directly
