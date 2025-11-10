# HyperAgent CDP Architecture Overview

Phase-by-phase snapshot of the end state we are marching toward. Each layer builds on the previous to deliver a fully CDP-driven agent that can run on Playwright, Puppeteer, or raw CDP sessions via connectors.

```
┌────────────────────────────────────────────────────────────────────────────┐
│                           Phase 6  (Diagnostics)                           │
│  Frame ↔ Driver Mapping, Debug artifacts, Optional driver hooks            │
└────────────┬───────────────────────────────────────────────────────────────┘
             │
┌────────────▼───────────────────────────────────────────────────────────────┐
│                           Phase 5  (Core Agent)                            │
│  CDP-only actions, Lifecycle/Network waits, structured logging, retries    │
└────────────┬───────────────────────────────────────────────────────────────┘
             │
┌────────────▼───────────────────────────────────────────────────────────────┐
│                      Phase 4  (Driver Abstraction)                         │
│  GenericPage/Context, Playwright & Puppeteer adapters, connectors          │
└────────────┬───────────────────────────────────────────────────────────────┘
             │
┌────────────▼───────────────────────────────────────────────────────────────┐
│                    Phase 3  (Frame & Lifecycle Core)                       │
│  FrameGraph, ExecutionContextRegistry, NetworkManager, LifecycleWatcher    │
└────────────┬───────────────────────────────────────────────────────────────┘
             │
┌────────────▼───────────────────────────────────────────────────────────────┐
│                     Phase 2  (CDP Element & Actions)                       │
│  Frame-first resolver, backend node cache, CDP interaction library, diffs  │
└────────────┬───────────────────────────────────────────────────────────────┘
             │
┌────────────▼───────────────────────────────────────────────────────────────┐
│                      Phase 1  (CDP Foundation)                             │
│  CDP client cache, transport/multiplexer, script injectors, adapters       │
└────────────────────────────────────────────────────────────────────────────┘
```

## Component Relationships

1. **CDP Transport & Sessions (Phase 1)**
   - `CdpConnection` owns the WebSocket, auto-attaches targets, multiplexes child sessions.
   - Script injector ensures bounding-box/DOM helpers exist in every session.

2. **Element Resolution & Actions (Phase 2)**
   - Encoded IDs decode to `{ frameIndex, backendNodeId }` → FrameGraph supplies frameId/session.
   - CDP interaction library (click, fill, drag, file upload, wheel) operates solely via CDP.
   - Snapshot diff/focus selectors reduce DOM payload sent to the LLM.

3. **FrameGraph, Execution Contexts, Network/Lifecycle (Phase 3)**
   - FrameGraph tracks parent/child links, session ownership, backend node IDs, ordinals.
   - ExecutionContextRegistry listens to `Runtime.executionContextCreated` per session.
   - NetworkManager + LifecycleWatcher coordinate `waitForDomIdle` across all frames.

4. **Driver Abstraction & Connectors (Phase 4)**
   - `GenericPage` interface hides Playwright/Puppeteer specifics.
   - `GenericContext` mirrors Stagehand’s context manager: manages multiple pages, popups, OOPIF adoption.
   - Connectors (`connectPlaywrightSession`, `connectPuppeteerSession`, raw CDP in future) plug user sessions into the stack.

5. **Core Agent (Phase 5)**
   - `runAgentTask` / `page.aiAction` call the LifecycleWatcher before/after each DOM fetch or action.
   - `ActionContext` exposes helpers (`resolveElement`, `executeCDPAction`, `getBoundingBox`, `waitForDomIdle`).
   - Structured logging and debug artifacts (`frameGraph.json`, `cdp-actions.json`, `network-log.json`).

6. **Frame-to-Driver Mapping (Phase 6)**
   - Optional map between CDP frameIds and driver handles for diagnostics or escape hatches.
   - Not required for execution but improves observability and parity with existing tooling.

## Execution Flow (High Level)

1. **Bootstrap**
   - Transport connects, auto-attaches targets, script injector installs helpers.
   - GenericContext creates `GenericPage` instances, FrameGraph + ExecutionContextRegistry begin tracking.
2. **DOM Capture**
   - LifecycleWatcher waits for network idle.
   - `getA11yDOM` uses FrameGraph + CDP sessions per frame, collecting encoded IDs, XPath, bounding boxes.
   - Snapshot diffing optionally trims the payload.
3. **LLM Planning**
   - Combined tree + screenshot sent to the model; result includes encoded IDs + methods.
4. **Action Execution**
   - `ActionContext.resolveElement(encodedId)` → frameId/session/backendNodeId via FrameGraph.
   - `executeCDPAction` runs the appropriate CDP routine (click, fill, etc.) with retries.
   - LifecycleWatcher confirms DOM settled afterward.
5. **Diagnostics**
   - Each step logs frameId/backendNodeId, bounding boxes, CDP commands, network state.
   - Optional frame-driver map surfaces driver-specific handles when needed.

This layered approach ensures we can swap browser drivers, adopt connectors, and continue iterating on agent intelligence without revisiting the foundational plumbing. Each phase builds concrete subsystems that the subsequent phases rely on, culminating in a fully CDP-native agent runtime.
