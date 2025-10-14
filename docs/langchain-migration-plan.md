# LangChain Decommissioning & Native SDK Migration Plan

## 1. Current LangChain Footprint

### Core runtime dependencies
- `HyperAgent` currently requires a `BaseChatModel` (LangChain) instance and lazily falls back to `ChatOpenAI` when no model is provided.【F:src/agent/index.ts†L1-L99】
- The global agent context (`AgentCtx`, `ActionContext`, `HyperAgentConfig`) and related utilities store the LLM as a `BaseChatModel`, forcing LangChain types through the entire runtime stack.【F:src/types/config.ts†L1-L72】【F:src/types/agent/actions/types.ts†L1-L58】【F:src/agent/tools/types.ts†L1-L14】
- Structured output selection is implemented via `BaseChatModel.withStructuredOutput`/`getName`, so provider-specific behavior is hidden behind LangChain’s abstraction.【F:src/agent/llms/structured-output.ts†L1-L18】
- Message construction relies on LangChain’s `BaseMessageLike` type, constraining us to LangChain’s multimodal payload format.【F:src/agent/messages/builder.ts†L1-L89】
- Agent actions (for example, `extract`) directly call `ctx.llm.invoke`, again assuming LangChain’s API for tool execution.【F:src/agent/actions/extract.ts†L18-L73】

### Secondary surfaces
- CLI/eval tooling, documentation, and examples import LangChain model classes (`@langchain/openai`, `@langchain/anthropic`).【F:scripts/run-webvoyager-eval.ts†L1-L174】【F:README.md†L67-L108】【F:examples/llms/openai.ts†L1-L71】【F:examples/llms/anthropic.ts†L1-L70】
- `package.json` pulls in `langchain`, `@langchain/core`, `@langchain/openai`, and `@langchain/anthropic` as dependencies/devDependencies.【F:package.json†L31-L76】
- Dozens of example workflows (`examples/simple`, `examples/mcp`, etc.) instantiate LangChain chat models; each must be updated or annotated to reflect new SDK usage.【F:examples/simple/add-to-amazon-cart.ts†L1-L120】【F:examples/mcp/weather/get-weather-alert.ts†L1-L160】

## 2. Migration Objectives
1. **Decouple the runtime from LangChain types** by introducing a provider-agnostic LLM interface that captures only the behaviors HyperAgent needs (non-streaming chat completion with multimodal prompts, optional structured JSON output, and metadata access such as provider/model identifiers).
2. **Adopt official SDKs** for OpenAI (`openai`), Anthropic (`@anthropic-ai/sdk`), and Gemini (`@google/generative-ai` / `@google/genai`) while keeping the door open for additional vendors through the new interface.
3. **Preserve feature parity**: structured outputs, image + text inputs, tool calling, and error semantics must remain consistent after the migration.
4. **Minimize breaking changes** for downstream consumers by providing adapters and transitional types where necessary.
5. **Remove all LangChain dependencies** (runtime and dev) and related type imports, documentation snippets, and build artifacts.

## 3. Target Architecture
### 3.1 LLM abstraction layer
- Create `src/llm/types.ts` that defines:
  - `HyperAgentLLM` interface with methods `invoke(messages, options)`, `invokeStructured(schema, messages, options)`, `getProviderId()`, `getModelId()`, and `getCapabilities()` (e.g., `{ multimodal: boolean, toolCalling: boolean, jsonMode: boolean }`).
  - `HyperAgentMessage`/`HyperAgentContentPart` union types that capture plain text, images (base64/url), and structured tool inputs independent of LangChain.
  - `StructuredOutputRequest` type bundling `zod` schema, call options, and provider-specific hints (e.g., `forceJson`, `toolName`).
- Implement request/response normalizers so the rest of the agent operates on these lightweight primitives (e.g., `normalizeAgentMessages` in `src/agent/messages`).

### 3.2 Native SDK clients
- **OpenAI**: wrap the official `openai` client. Use `client.responses.create` (preferred for multimodal/JSON) or `client.chat.completions.create` when responses API unavailable. Support JSON schema by translating `zod` schema with `zod-to-json-schema` and setting `response_format: { type: "json_schema", json_schema: ... }`. Implement tool calling by defining `tool_choice` payloads.
- **Anthropic**: wrap `@anthropic-ai/sdk` `messages.create`. Map our message schema to Anthropic’s `{ role, content: [{ type: "text" | "image", ... }] }`. Provide structured output via `tool_choice` and `tools` arrays. Handle streaming/`max_output_tokens` defaults.
- **Gemini**: leverage `@google/genai` `GenerativeModel.generateContent` + `generateContentStream`. Configure `systemInstruction` and `responseSchema` for JSON output. Implement tool calling via function declarations (if needed for parity) or document limitations.
- Extendable provider registry (e.g., `src/llm/providers/index.ts`) with factory functions `createLLMClient({ provider: "openai" | "anthropic" | "gemini", apiKey, model, ... })`.

### 3.3 Agent integration
- Refactor `HyperAgent` constructor to accept either a concrete `HyperAgentLLM` or a config object from which we instantiate a provider-specific client. Default to OpenAI official SDK when `OPENAI_API_KEY` is present, but allow explicit provider selection.
- Update agent state (`AgentCtx`, `ActionContext`, etc.) to store the new interface. Ensure methods invoking `withStructuredOutput` now call a helper `invokeStructuredOutput(llm, schema, messages, options)` that dispatches to provider-specific logic.
- Replace `BaseMessageLike` usage with the new message type; update `buildAgentStepMessages` to produce `HyperAgentMessage[]`. Provide adapter functions for each provider to map to their API payloads.
- Rework `getStructuredOutputMethod` into provider-specific strategies (e.g., `OpenAIJsonModeStrategy`, `AnthropicToolStrategy`, `GeminiSchemaStrategy`).

### 3.4 Supporting utilities
- Implement shared helpers for:
  - Converting `zod` schemas to provider payloads.
  - Encoding screenshots for Gemini (which expects inline data or Google Storage references) and Anthropic (base64 with MIME type).
  - Rate-limit and error normalization (convert provider-specific errors into `HyperagentError`).
- Update retry/backoff utilities if provider SDKs throw different error shapes.

## 4. Incremental Migration Steps
1. **Scaffold the abstraction** (`src/llm/` folder) and unit tests that validate message normalization and structured-output translation.
2. **Implement provider clients** one-by-one:
   - Start with OpenAI (default path) to ensure agent bootstraps with the new interface.
   - Add Anthropic, mirroring existing structured-output behavior (`functionCalling`).
   - Add Gemini, paying attention to image handling and schema enforcement.
3. **Refactor core agent modules** to consume the new interface:
   - Update `HyperAgent`, `runAgentTask`, action implementations, and message builders.
   - Replace calls to `llm.invoke`/`withStructuredOutput` with the abstraction functions.
4. **Adjust task orchestration** so `ctx.llm` is typed as `HyperAgentLLM`. Update TypeScript generics and ensure `zod` schema flows compile.
5. **Migrate ancillary tooling**:
   - Update eval script to import the new OpenAI client factory and drop LangChain types.【F:scripts/run-webvoyager-eval.ts†L1-L174】
   - Rewrite examples to use provider factories or inline SDK clients.【F:examples/llms/openai.ts†L1-L71】【F:examples/llms/anthropic.ts†L1-L70】
   - Refresh README snippets to showcase native SDK usage.【F:README.md†L67-L108】
6. **Deprecate LangChain packages** from `package.json` and ensure lockfile regeneration.【F:package.json†L31-L76】
7. **Add regression coverage**:
   - Introduce unit tests for message conversion and structured output.
   - Add provider-specific smoke tests guarded by API keys (skipped in CI if keys absent) to validate multimodal prompts and schema parsing.
   - Update existing integration/e2e harnesses to rely on the new clients.
8. **Documentation & upgrade guide** describing the breaking changes (e.g., new LLM config API) and migration steps for consumers.
9. **Final cleanup**: remove unused LangChain-specific helpers, ensure tree-shaking, run lint/tests, and verify bundle size.

## 5. Risk Mitigation
- **Structured output parity**: Validate that each provider’s JSON/tooling mode matches previous behavior; add adapter-level tests comparing outputs against canned responses.
- **Multimodal payload differences**: Gemini requires MIME metadata for images and may reject large base64 payloads—implement chunking or fallbacks (e.g., host screenshot temporarily) and document constraints.
- **Rate limit & error handling**: Provider SDKs expose different error types/status codes; add normalization layer to keep existing error semantics (especially for retries in `retry()` utility).
- **Backward compatibility**: Provide `createLangChainAdapter` temporarily (optional) or release a new major version with clear upgrade instructions.
- **Key management**: Document new environment variables (`GOOGLE_API_KEY`, `ANTHROPIC_API_KEY`, etc.) and update configuration schema validation to surface missing keys early.

## 6. Deliverables Checklist
- [ ] New `src/llm/` module with shared types, providers, and helpers.
- [ ] Updated agent core (`src/agent/**`) to use native SDK abstraction.
- [ ] Updated examples, scripts, and docs referencing new APIs.
- [ ] Removal of all LangChain dependencies and related imports.
- [ ] Comprehensive tests covering providers and structured outputs.
- [ ] Migration guide (appendix in README or standalone doc) summarizing breaking changes for downstream users.

## 7. Suggested Timeline
1. **Week 1** – Design final interfaces, implement OpenAI client, and migrate core agent pathways using OpenAI only.
2. **Week 2** – Add Anthropic + Gemini implementations, cover structured output/tool calling, update docs/examples.
3. **Week 3** – Harden tests, expand provider support matrix, write migration guide, run regression suite, and remove LangChain packages.

## 8. Follow-up Enhancements
- Investigate adding caching/logging hooks per provider (e.g., OpenAI responses API’s `metadata` field).
- Explore streaming support in the abstraction for future UI integrations.
- Provide pluggable middleware (logging, tracing) to replace LangChain callbacks if needed.
- Offer factory utilities for additional vendors (Groq, Mistral) using the same interface.
