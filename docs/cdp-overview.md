# CDP / Agent Integration Deep Dive

This document explains every relevant function added or changed since commit `f3cdfb478f5dfc724c24309165ad961c914064e0`. It targets readers with zero context and covers:

1. Frame/session infrastructure and why it exists.
2. How the accessibility DOM (A11yDOM) pipeline gathers full-frame data.
3. How bounding boxes/visual overlays work without Playwright.
4. How `page.aiAction()` (`executeAction`/`runAgentTask`) and `page.ai()` (`executeSingleAction`) flow through CDP.
5. What each CDP runtime action does under the hood.
6. **THE BIG PICTURE: Why we have so many maps and events**
7. Areas that still need abstraction or cleanup.

---

## 0. THE BIG PICTURE: The Map Problem & Why We Need Multiple Event Listeners

### Why So Many Maps?

**TL;DR:** Chrome separates DOM structure, accessibility data, frame information, and execution contexts into different CDP domains. We need multiple maps to stitch them together because Chrome doesn't provide a single unified view.

### The Core Problem: Multiple Identifiers for the Same Element

When you click a button on a webpage with iframes, Chrome needs to track that element using **4 different identifiers**:

1. **`backendNodeId`** (DOM domain) - Identifies the DOM node
2. **`nodeId`** (Accessibility domain) - Identifies the accessibility tree node
3. **`frameId`** (Page domain) - Identifies which frame contains the element
4. **`executionContextId`** (Runtime domain) - Identifies the JavaScript execution context to run scripts in that frame

**The problem:** These IDs are managed by separate CDP domains and are NOT directly linked by Chrome!

### Concrete Example: A Button in an Iframe

Let's say we have this HTML structure:

```html
<!-- Main page (frameIndex 0) -->
<html>
  <body>
    <button id="main-btn">Click Me</button>
    <iframe src="/child.html"></iframe>
  </body>
</html>

<!-- child.html (frameIndex 1) -->
<html>
  <body>
    <button id="iframe-btn">I'm in an iframe</button>
  </body>
</html>
```

When the agent needs to click `#iframe-btn`, here's what we need to resolve:

| **What We Know** | **What We Need to Find** | **Which Map Provides It** |
|------------------|---------------------------|----------------------------|
| LLM says: "click the button with text 'I'm in an iframe'" | Which `encodedId` is this element? | `elements` Map (from A11y tree) → **`1-42`** (frame 1, node 42) |
| `encodedId: "1-42"` | What's the `backendNodeId`? | `backendNodeMap["1-42"]` → **`42`** |
| `encodedId: "1-42"` | What's the XPath to this element? | `xpathMap["1-42"]` → **`"//button[1]"`** |
| `frameIndex: 1` | What's the iframe metadata? | `frameMap.get(1)` → `IframeInfo` |
| `frameIndex: 1` | What's the Chrome `frameId`? | `IframeInfo.frameId` → **`"ABC123"`** OR `FrameContextManager.getFrameIdByIndex(1)` → **`"ABC123"`** |
| `frameId: "ABC123"` | Which CDP session controls this frame? | `FrameContextManager.getFrameSession("ABC123")` → **`CDPSession`** |
| `frameId: "ABC123"` | What's the `executionContextId` to run scripts? | `FrameContextManager.getExecutionContextId("ABC123")` → **`5`** |
| `backendNodeId: 42` + `executionContextId: 5` | How do I click this element? | `resolveElement()` + `dispatchCDPAction()` |

### The 5 Core Maps Explained

#### 1. **`backendNodeMap: Record<EncodedId, backendNodeId>`**
**Purpose:** Links our stable `encodedId` to Chrome's DOM `backendNodeId`

**Example Data:**
```typescript
{
  "0-15": 15,   // Main frame button
  "1-42": 42,   // Iframe button  
  "1-43": 43,   // Iframe input field
}
```

**Why?** Chrome DOM APIs require `backendNodeId` to resolve nodes, get bounding boxes, etc. But `backendNodeId` can change on navigation, so we track it.

---

#### 2. **`xpathMap: Record<EncodedId, string>`**
**Purpose:** Stores XPath to recover elements if `backendNodeId` becomes stale

**Example Data:**
```typescript
{
  "0-15": "//html[1]/body[1]/button[1]",
  "1-42": "//button[1]",  // Relative to iframe document!
  "1-43": "//input[1]"
}
```

**Why?** If a navigation or DOM mutation invalidates our `backendNodeId`, we can re-find the element by evaluating its XPath in the correct execution context.

---

#### 3. **`frameMap: Map<frameIndex, IframeInfo>`**
**Purpose:** Tracks metadata about each iframe discovered during DOM traversal

**Example Data (after full pipeline - see note below):**
```typescript
Map {
  1 => {
    frameIndex: 1,
    src: "/child.html",
    xpath: "//iframe[1]",
    frameId: "ABC123",               // Added later by syncFrameContextManager
    executionContextId: 5,           // Added later by syncFrameContextManager
    parentFrameIndex: 0,
    iframeBackendNodeId: 99,         // ✅ From DOM.getDocument
    contentDocumentBackendNodeId: 100, // ✅ From DOM.getDocument
    absoluteBoundingBox: {           // Position in main viewport
      x: 0, y: 200, width: 800, height: 600,
      top: 200, left: 0, right: 800, bottom: 800
    }
  }
}
```

**⚠️ CRITICAL: Same-Origin Iframes Don't Have `frameId` Initially**

When `buildBackendIdMaps()` calls `DOM.getDocument({ pierce: true })`, Chrome returns:
- ✅ `iframeBackendNodeId` (the `<iframe>` element's backendNodeId)  
- ✅ `contentDocument` (the iframe's complete DOM tree with all elements)
- ❌ **NO `frameId`** (Chrome doesn't populate this in DOM responses for same-origin iframes!)

**Where `frameId` comes from:**
- CDP **events**: `Page.frameAttached` fires when iframe loads → gives us `frameId: "ABC123"`
- We call `DOM.getFrameOwner("ABC123")` → returns `{ backendNodeId: 99 }`
- Now we can match: `backendNodeId 99` in `frameMap[1]` ↔ `frameId "ABC123"` from events
- `syncFrameContextManager()` does this matching and populates the missing fields

**This is THE primary reason we need event listeners.** See Section 0.6 for the complete flow.

**Why?** When we need to act on an element with `encodedId "1-42"`, we parse the frame index (`1`), look up the iframe metadata, get its `frameId` and `executionContextId`, then use those to send CDP commands.

---

#### 4. **`FrameContextManager` (FrameGraph + Session Map + Execution Context Map)**
**Purpose:** Real-time tracking of frame lifecycle, sessions, and execution contexts via CDP events

**Internal State:**
```typescript
// FrameGraph: Maps frameId ↔ frameIndex and stores frame hierarchy
graph: {
  frames: Map {
    "ABC123" => {
      frameId: "ABC123",
      frameIndex: 1,
      parentFrameId: "ROOT",
      url: "https://example.com/child.html",
      name: undefined,
      sessionId: "session-2",
      backendNodeId: 99
    }
  },
  frameIndexMap: Map {
    1 => "ABC123"
  }
}

// Session map: Which CDP session controls each frame?
sessions: Map {
  "ROOT" => CDPSession (main),
  "ABC123" => CDPSession (iframe or same as main for same-origin)
}

// Execution context map: Which context ID to use for each frame?
frameExecutionContexts: Map {
  "ROOT" => 1,
  "ABC123" => 5
}
```

**Why?** Chrome emits events when frames attach/detach/navigate. We need to track these in real-time so we always know:
- Which CDP session to send commands to
- Which execution context to use for script evaluation
- The frame hierarchy (parent → child relationships)

---

#### 5. **`elements: Map<EncodedId, AccessibilityNode>`**
**Purpose:** Maps `encodedId` to the full accessibility node (role, name, value, etc.)

**Example Data:**
```typescript
Map {
  "0-15" => {
    role: "button",
    name: "Click Me",
    backendDOMNodeId: 15,
    nodeId: "ax-node-123",
    encodedId: "0-15"
  },
  "1-42" => {
    role: "button",
    name: "I'm in an iframe",
    backendDOMNodeId: 42,
    nodeId: "ax-node-456",
    encodedId: "1-42"
  }
}
```

**Why?** The LLM needs semantic information (role, label, value) to decide which element to interact with. The A11y tree provides this, but we need to enrich it with `encodedId` and cross-reference it with our other maps.

---

### Why We Need Multiple CDP Event Listeners

**PRIMARY REASON:** `DOM.getDocument` doesn't give us `frameId` for same-origin iframes. Events provide it.

| **Event** | **What It Provides** | **Why We Need It** | **Example** |
|-----------|----------------------|---------------------|-------------|
| `Page.getFrameTree` (API - called once) | Initial frame tree at load time | **Gives us `frameId` for all frames that exist at page load** | `{ frameTree: { frame: {...}, childFrames: [...] } }` |
| `Page.frameAttached` (Event - ongoing) | A frame was added to the page | **Captures dynamically created iframes after page load** | `{ frameId: "ABC123", parentFrameId: "ROOT" }` |
| `DOM.getFrameOwner` (API call) | Gives `backendNodeId` of `<iframe>` element | **THE BRIDGE: Links `frameId` to `backendNodeId`** | `{ backendNodeId: 99, nodeId: 88 }` |
| `Runtime.executionContextCreated` | JavaScript context created | **Links `frameId → executionContextId` to run scripts** | `{ context: { id: 5, auxData: { frameId: "ABC123" } } }` |
| `Page.frameNavigated` | A frame navigated to a new URL | Updates frame URL, new context coming | `{ frame: { id: "ABC123", url: "..." } }` |
| `Page.frameDetached` | A frame was removed | Clean up our maps and sessions | `{ frameId: "ABC123" }` |
| `Runtime.executionContextDestroyed` | JavaScript context destroyed | Clear stale context IDs | `{ executionContextId: 5 }` |

**Key Insight:** 
- `Page.getFrameTree` gives us `frameId` for frames that exist at load time
- `DOM.getDocument` gives us DOM structure but NO `frameId`
- `Page.frameAttached` events catch dynamically added iframes
- `DOM.getFrameOwner` bridges the two by linking `frameId` ↔ `backendNodeId`

---

### The Data Flow: From LLM Instruction to CDP Command

Here's the complete flow when the agent executes `page.aiAction("click the button in the iframe")`:

```
1. [LLM Input] "click the button in the iframe"
   ↓
2. [findElementWithRetry] Call getA11yDOM() to build element tree
   ↓
3. [getA11yDOM] 
   - buildBackendIdMaps(): Walk DOM via CDP, create:
     * backendNodeMap: { "1-42": 42 }
     * xpathMap: { "1-42": "//button[1]" }
     * frameMap: Map { 1 => { iframeBackendNodeId: 99, frameId: undefined } }
   - syncFrameContextManager(): Match via backendNodeId, populate:
     * frameMap[1].frameId = "ABC123" ✅
     * frameMap[1].executionContextId = 5 ✅
   - fetchIframeAXTrees(): Get accessibility trees for each frame
   - buildHierarchicalTree(): Merge AX + DOM data, create:
     * elements: Map { "1-42": { role: "button", name: "I'm in an iframe" } }
   ↓
4. [LLM] Analyze `elements` map, return:
   { elementId: "1-42", method: "click", arguments: [] }
   ↓
5. [executeSingleAction] Parse encodedId "1-42" → frameIndex = 1
   ↓
6. [resolveElement]
   - frameIndex=1 → frameMap.get(1) → frameId="ABC123"
   - FrameContextManager.getFrameSession("ABC123") → CDP session
   - FrameContextManager.getExecutionContextId("ABC123") → contextId=5
   - backendNodeMap["1-42"] → backendNodeId=42
   ↓
7. [dispatchCDPAction("click")]
   - Send CDP command: DOM.scrollIntoViewIfNeeded({ backendNodeId: 42 })
   - Send CDP command: Input.dispatchMouseEvent({ type: "mouseMoved", x: 400, y: 500 })
   - Send CDP command: Input.dispatchMouseEvent({ type: "mousePressed", button: "left" })
   - Send CDP command: Input.dispatchMouseEvent({ type: "mouseReleased", button: "left" })
```

---

### Summary: Why the Complexity?

1. **Chrome's CDP has NO unified element identifier** - We create `encodedId` to bridge domains
2. **Frames add another layer** - Same `backendNodeId` could exist in multiple frames
3. **IDs become stale** - Navigation/mutations require XPath fallback
4. **Scripts need execution contexts** - Can't evaluate XPath without the right `contextId`
5. **OOPIF frames need separate sessions** - Cross-origin iframes require their own CDP connection

The maps and events work together to maintain a **bidirectional translation table** between:
- Human instructions ("click the button")
- LLM-friendly accessibility tree (role, name, value)
- Chrome's internal identifiers (`backendNodeId`, `frameId`, `executionContextId`)
- CDP commands that actually perform actions

---

## 0.5. Real Debug Output Examples

To make this concrete, here's what actual debug output looks like when the agent processes a page with iframes.

### Example 1: DOM Traversal Output (`buildBackendIdMaps`)

When `buildBackendIdMaps()` walks the DOM tree:

```
[DOM] Same-origin iframe without frameId (expected) - will match by backendNodeId=123
[DOM] Iframe detected: frameIndex=1, parent=0, iframeBackendNodeId=123, contentDocBackendNodeId=456, cdpFrameId="undefined", src="https://example.com/frame1.html", siblingPos=0

[DOM.getDocument] DOM tree statistics:
  Frame 0 (https://example.com): 1247 DOM nodes, 15 input/textarea elements
  Frame 1 (https://example.com/frame1.html): 89 DOM nodes, 3 input/textarea elements
```

**What's happening:** The DFS traversal found 2 frames:
- Frame 0 (main): 1247 nodes
- Frame 1 (same-origin iframe): 89 nodes - **Note: `cdpFrameId="undefined"` is expected!**

**OOPIF frames don't appear here** - they're discovered later via `captureOOPIFs()`

### Example 2: Frame Context Manager State

After `ensureInitialized()`, the FrameContextManager contains:

```json
{
  "graph": {
    "frames": {
      "E8F7A9B2C1D3E4F5": {
        "frameId": "E8F7A9B2C1D3E4F5",
        "frameIndex": 1,
        "parentFrameId": "ROOT_FRAME_ID",
        "url": "https://example.com/frame1.html",
        "name": "content-frame",
        "sessionId": "CDP-Session-1",
        "backendNodeId": 123,
        "lastUpdated": 1731782400000
      },
      "F9G8H7I6J5K4L3M2": {
        "frameId": "F9G8H7I6J5K4L3M2",
        "frameIndex": 2,
        "parentFrameId": "ROOT_FRAME_ID",
        "url": "https://ads.example.com/ad.html",
        "name": null,
        "sessionId": "CDP-Session-2",
        "backendNodeId": 789,
        "lastUpdated": 1731782401000
      }
    },
    "frameIndexMap": {
      "0": "ROOT_FRAME_ID",
      "1": "E8F7A9B2C1D3E4F5",
      "2": "F9G8H7I6J5K4L3M2"
    }
  }
}
```

**Key observations:**
- Frame 0 (main) uses the root session
- Frame 1 (same-origin) shares the root session (`CDP-Session-1`)
- Frame 2 (OOPIF) gets its own session (`CDP-Session-2`)
- Each frame has a stable `frameIndex` for our `encodedId` scheme

### Example 3: Accessibility Tree with EncodedIds

After `buildHierarchicalTree()`, the `elements` map looks like:

```typescript
Map {
  "0-45" => {
    role: "button",
    name: "Login",
    backendDOMNodeId: 45,
    nodeId: "ax-129",
    encodedId: "0-45",
    boundingBox: { x: 100, y: 200, width: 80, height: 40, ... }
  },
  "1-23" => {
    role: "textbox",
    name: "Email",
    value: "",
    backendDOMNodeId: 23,
    nodeId: "ax-456",
    encodedId: "1-23",
    boundingBox: { x: 50, y: 350, width: 200, height: 30, ... }
  },
  "2-67" => {
    role: "link",
    name: "Click Here for Deals",
    backendDOMNodeId: 67,
    nodeId: "ax-789",
    encodedId: "2-67"
  }
}
```

**Notice:**
- `"0-45"` = Main frame, backendNodeId=45
- `"1-23"` = Frame 1, backendNodeId=23 (relative to that frame's document!)
- `"2-67"` = Frame 2 (OOPIF), backendNodeId=67

### Example 4: Event Timeline & frameIndex Assignment

**Critical Clarification:** `frameIndex` is assigned by **DOM traversal order**, not event order!

Here's the complete timeline showing both CDP events and DOM traversal:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PHASE 1: INITIALIZATION (ensureFrameContextsReady)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[00:00.000] FrameContextManager.ensureInitialized()
  → Page.getFrameTree() - enumerate existing frames
  ├─ Root: { id: "ROOT", parentId: null }
  │  └─ Assigns preliminary frameIndex=0
  ├─ Child: { id: "E8F7A9B2C1D3E4F5", parentId: "ROOT" }
  │  └─ Assigns preliminary frameIndex=1
  └─ Registers frames in FrameGraph

[00:00.020] Attach event listeners
  → Page.frameAttached, Page.frameNavigated, Page.frameDetached
  → Runtime.executionContextCreated, Runtime.executionContextDestroyed

[00:00.050] Page.frameNavigated (for each frame)
  { frame: { id: "E8F7A9B2C1D3E4F5", url: "/frame1.html" } }
  → Updates URL in FrameGraph

[00:00.120] Runtime.executionContextCreated
  { context: { id: 5, auxData: { frameId: "E8F7A9B2C1D3E4F5" } } }
  → frameExecutionContexts.set("E8F7A9B2C1D3E4F5", 5)

FrameContextManager State:
────────────────────────────────────────────────────────────
[FrameGraph]
  "ROOT" → { frameId: "ROOT", frameIndex: 0, ... }
  "E8F7A9B2C1D3E4F5" → { frameId: "E8F7A9B2C1D3E4F5", frameIndex: 1, ... }

[frameExecutionContexts]
  "ROOT" → 1
  "E8F7A9B2C1D3E4F5" → 5

⚠️  frameIndex assignments are PRELIMINARY - will be overwritten!


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PHASE 2: DOM TRAVERSAL (getA11yDOM → buildBackendIdMaps)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[00:00.200] buildBackendIdMaps() - DFS traversal
  let nextFrameIndex = 0 + 1;  // Start at 1
  
  Walking DOM tree...
  ├─ <html> (frameIndex=0, main frame)
  │  ├─ <button> → encodedId "0-15"
  │  ├─ <iframe src="/frame1.html">  ← contentDocument available!
  │  │  │  frameId from response: "E8F7A9B2C1D3E4F5"
  │  │  │  Assign: iframeFrameIndex = nextFrameIndex++ = 1
  │  │  │
  │  │  └─ Create IframeInfo:
  │  │     {
  │  │       frameIndex: 1,  ← AUTHORITATIVE!
  │  │       frameId: "E8F7A9B2C1D3E4F5",
  │  │       iframeBackendNodeId: 99,
  │  │       executionContextId: undefined  ← Don't have yet
  │  │     }
  │  │
  │  └─ <iframe src="/frame2.html">
  │     │  Assign: iframeFrameIndex = nextFrameIndex++ = 2
  │     └─ Create IframeInfo with frameIndex: 2

DOM Traversal Result:
────────────────────────────────────────────────────────────
[frameMap] - frameIndex assigned by DFS order!
  0 → (implicit main frame)
  1 → { frameIndex: 1, frameId: "E8F7A9B2C1D3E4F5", ... }
  2 → { frameIndex: 2, frameId: "F9G8H7I6J5K4L3M2", ... }

[backendNodeMap]
  "0-15" → 15   // Main frame button
  "1-42" → 42   // Frame 1 button
  "2-67" → 67   // Frame 2 button


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PHASE 3: SYNC (syncFrameContextManager)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[00:00.250] syncFrameContextManager(frameContextManager, frameMap)

For each entry in frameMap:
  frameIndex: 1, frameId: "E8F7A9B2C1D3E4F5"
  
  ├─ Look up in FrameContextManager by frameId
  ├─ Get executionContextId: 5
  ├─ Copy into frameMap: info.executionContextId = 5
  │
  └─ OVERWRITE frameIndex in FrameContextManager:
     manager.assignFrameIndex("E8F7A9B2C1D3E4F5", 1)
     
     This overwrites the preliminary assignment from Phase 1!

Final Synchronized State:
────────────────────────────────────────────────────────────
[FrameContextManager.FrameGraph]
  "ROOT" → { frameId: "ROOT", frameIndex: 0, ... }
  "E8F7A9B2C1D3E4F5" → { 
    frameId: "E8F7A9B2C1D3E4F5", 
    frameIndex: 1,  ← FROM DOM TRAVERSAL ORDER
    ...
  }

[frameMap]
  1 → { 
    frameIndex: 1, 
    frameId: "E8F7A9B2C1D3E4F5",
    executionContextId: 5  ← FROM CDP EVENTS
  }

Both views now agree: frameIndex determined by DOM order,
executionContextId from CDP events!
```

**Key Takeaways:**

1. **frameIndex is determined by DOM traversal order (buildBackendIdMaps)**
   - DFS walk of DOM tree
   - Each iframe discovered gets `nextFrameIndex++`
   - This is the authoritative assignment

2. **executionContextId is determined by CDP events**
   - `Runtime.executionContextCreated` fires asynchronously
   - Captured by FrameContextManager event listeners
   - Copied into frameMap during sync

3. **syncFrameContextManager merges the two views**
   - frameIndex: from frameMap (DOM order) → FrameContextManager
   - executionContextId: from FrameContextManager → frameMap

4. **Why this matters:**
   - Encoded IDs use frameIndex: `"1-42"` means frame 1, node 42
   - Frame 1 is whichever iframe was discovered FIRST in DOM traversal
   - NOT whichever frame attached first in CDP events!

### Example 5: Element Resolution Debug Log

When `resolveElement("1-23")` is called:

```
[ElementResolver] Resolving encodedId="1-23"
[ElementResolver] frameIndex=1 → frameId="E8F7A9B2C1D3E4F5"
[ElementResolver] backendNodeMap["1-23"] → backendNodeId=23
[ElementResolver] FrameContextManager.getFrameSession("E8F7A9B2C1D3E4F5") → CDP-Session-1
[ElementResolver] FrameContextManager.getExecutionContextId("E8F7A9B2C1D3E4F5") → contextId=5
[ElementResolver] Resolved 1-23 via backendNodeId 23 (frameId=E8F7A9B2C1D3E4F5, session=CDP-Session-1)
```

**If the element is stale (navigation occurred):**

```
[ElementResolver] DOM.resolveNode failed: "Could not find node with given id"
[ElementResolver] Recovering backendNodeId for 1-23 via XPath (frameIndex=1, frameId=E8F7A9B2C1D3E4F5)
[ElementResolver] xpathMap["1-23"] → "//input[@type='email'][1]"
[ElementResolver] Runtime.evaluate in contextId=5
[ElementResolver] XPath recovery succeeded for 1-23 (backendNodeId=98)
```

**Key insight:** When `backendNodeId` becomes stale, we use XPath + executionContextId to re-find the element.

### Example 6: Bounding Box Translation for Iframes

When we collect bounding boxes for an iframe element at `encodedId="1-23"`:

**Before translation (raw coordinates relative to iframe):**
```typescript
boundingBoxMap.get("1-23") → { x: 50, y: 100, width: 200, height: 30 }
```

**After translation (coordinates relative to main viewport):**
```typescript
// frameMap.get(1).absoluteBoundingBox → { x: 0, y: 400, width: 800, height: 600 }
// Translated rect:
boundingBoxMap.get("1-23") → { x: 50, y: 500, width: 200, height: 30 }
//                                 ↑    ↑
//                         iframe.x + elem.x
//                                      iframe.y + elem.y
```

**Why?** Bounding boxes from iframe elements are relative to the iframe's viewport, not the main page. We need to add the iframe's offset so mouse clicks land in the right place.

---

## 0.6. The Synchronization Challenge: Why Events Are Critical

### The Primary Problem: Same-Origin Iframes Don't Have `frameId`

**Question:** Why can't we just call `DOM.getDocument` once and be done?

**Answer:** Because `DOM.getDocument` doesn't give us `frameId` for same-origin iframes.

**What `DOM.getDocument` provides:**
- ✅ The `<iframe>` element with its `backendNodeId` (e.g., 99)
- ✅ The iframe's complete `contentDocument` with all its elements
- ✅ All elements inside the iframe with their `backendNodeIds`
- ❌ **NO `frameId`** for the iframe

**Why we need `frameId`:**
- To get the correct CDP session for the frame
- To get the `executionContextId` for running scripts in that frame
- To match DOM data with event-driven frame tracking

**Secondary problems:**
1. **OOPIFs: Completely invisible** - Cross-origin iframes don't appear in `DOM.getDocument` at all
2. **No execution contexts** - `DOM.getDocument` never returns `executionContextId`
3. **Dynamic changes** - Iframes can be added/removed after page load

### What DOM.getDocument Actually Returns

Let's see what we actually get from `DOM.getDocument`:

```typescript
// Time T=0: Page with same-origin iframe and OOPIF
await page.goto("https://example.com");

// Time T=100ms: We call DOM.getDocument
const { root } = await session.send("DOM.getDocument", { pierce: true });

// What we GET:
// ✅ <iframe> tag for same-origin iframe (backendNodeId: 99)
// ✅ contentDocument for same-origin iframe (backendNodeId: 100)
// ✅ All elements inside same-origin iframe
// ❌ NO frameId for the iframe
// ❌ NO executionContextId for any frame
// ❌ OOPIF iframe is COMPLETELY MISSING (cross-origin blocked)

// Our frameMap after DOM traversal:
{
  frameIndex: 1,
  iframeBackendNodeId: 99,           // ✅ We have this
  contentDocumentBackendNodeId: 100,  // ✅ We have this
  frameId: undefined,                 // ❌ Missing!
  executionContextId: undefined       // ❌ Missing!
}

// OOPIFs don't even appear in the traversal!
```

### Why We Need CDP Events: The Complete Flow

To get the missing pieces, we need a multi-step process involving `ensureInitialized()` and event listeners:

#### Step 1: ensureInitialized() - Capture Initial Frames

**Location:** `src/cdp/frame-context-manager.ts` (line 206)

```typescript
async ensureInitialized(): Promise<void> {
  if (this.initialized) return;
  
  // Step 1a: Capture frames that exist at page load
  await this.captureFrameTree(rootSession);
  
  // Step 1b: Attach event listeners for frames that load LATER
  await this.trackPageEvents(rootSession);
  
  this.initialized = true;
}
```

**Step 1a: captureFrameTree() - Get Existing Frames**

```typescript
private async captureFrameTree(session: CDPSession): Promise<void> {
  // Call Page.getFrameTree to get all frames that exist RIGHT NOW
  const { frameTree } = await session.send("Page.getFrameTree");
  
  for (const node of traverse(frameTree)) {
    const frameId = node.frame.id;  // ✅ We get frameId from getFrameTree!
    
    // For each frame, call populateFrameOwner to get backendNodeId
    await this.populateFrameOwner(session, frameId);
  }
}

// THE KEY METHOD: Links frameId to backendNodeId
private async populateFrameOwner(session: CDPSession, frameId: string): Promise<void> {
  // Call DOM.getFrameOwner with the frameId to get backendNodeId
  const owner = await session.send("DOM.getFrameOwner", { frameId });
  
  // Store backendNodeId in the frame record
  this.graph.upsertFrame({ 
    frameId,
    backendNodeId: owner.backendNodeId  // ✅ THIS is the link!
  });
}
```

**Why we need backendNodeId:**
- FrameContextManager knows: `frameId: "ABC123"`
- DOM traversal knows: `iframeBackendNodeId: 99`
- `DOM.getFrameOwner("ABC123")` returns: `{ backendNodeId: 99 }`
- Now we can match them! `frameId "ABC123" ↔ backendNodeId 99`

**Step 1b: trackPageEvents() - Listen for New Frames**

**Problem:** Some iframes load AFTER `Page.getFrameTree` is called (dynamic iframes, lazy-loaded content, etc.)

**Solution:** Attach event listeners to catch these late-loading frames

```typescript
private async trackPageEvents(session: CDPSession): Promise<void> {
  await session.send("Page.enable");
  
  // Listen for new frames that attach AFTER initialization
  session.on("Page.frameAttached", (event) => {
    this.handlePageFrameAttached(event);
  });
  
  session.on("Page.frameNavigated", (event) => {
    this.handlePageFrameNavigated(event);
  });
}

// When a new iframe loads:
private async handlePageFrameAttached(event: Protocol.Page.FrameAttachedEvent): Promise<void> {
  const frameId = event.frameId;  // ✅ We get frameId from the event!
  
  // Create frame record
  this.upsertFrame({ frameId, parentFrameId: event.parentFrameId });
  
  // Assign frameIndex
  this.assignFrameIndex(frameId, this.nextFrameIndex++);
  
  // THE KEY STEP: Get backendNodeId by calling DOM.getFrameOwner
  await this.populateFrameOwner(rootSession, frameId);
  // Now this frame also has backendNodeId and can be matched!
}
```

**Key Insight:** Both paths (initial + events) call `populateFrameOwner` → `DOM.getFrameOwner` to establish the `frameId ↔ backendNodeId` link.

#### Step 2: Runtime.executionContextCreated - Get Execution Contexts

```typescript
// Separate event for execution contexts
Runtime.executionContextCreated({
  context: {
    id: 5,               // ✅ executionContextId
    auxData: {
      frameId: "ABC123"  // Links it to the frame
    }
  }
})

// FrameContextManager stores this:
this.frameExecutionContexts.set("ABC123", 5);
```

#### Step 3: syncFrameContextManager() - Match Everything Together

**Location:** `src/context-providers/a11y-dom/index.ts` (line 218)

Now we need to connect:
- **frameMap** (from `buildBackendIdMaps` DOM traversal) - has `frameIndex` + `iframeBackendNodeId` but NO `frameId`
- **FrameContextManager** (from CDP events) - has `frameId` + `backendNodeId` + `executionContextId`

```typescript
async function syncFrameContextManager({ manager, frameMap }): Promise<void> {
  // For each iframe discovered in DOM traversal:
  for (const [frameIndex, info] of frameMap.entries()) {
    const iframeBackendNodeId = info.iframeBackendNodeId;  // e.g., 99
    
    // ⚠️ CRITICAL: Same-origin iframes don't have frameId in DOM response!
    // info.frameId is typically undefined here
    
    // Match by backendNodeId - the shared key!
    const matched = manager.getFrameByBackendNodeId(iframeBackendNodeId);
    
    if (matched) {
      const frameId = matched.frameId;  // e.g., "ABC123"
      
      console.log(
        `[FrameContext] Matched same-origin frame ${frameIndex} ` +
        `via backendNodeId ${iframeBackendNodeId} -> frameId ${frameId}`
      );
      
      // ✅ NOW we can populate the missing data in frameMap:
      info.frameId = frameId;  // From FrameContextManager
      info.executionContextId = manager.getExecutionContextId(frameId);  // From events
      
      // Also overwrite frameIndex in FrameContextManager with DOM traversal order
      // (DOM traversal order is authoritative for frame numbering)
      manager.assignFrameIndex(frameId, frameIndex);
    } else {
      // No match = transitional/unmatched frame (e.g., ad loading)
      console.warn(`[FrameContext] Frame ${frameIndex} could not be matched`);
    }
  }
}
```

---

### 🎯 KEY TAKEAWAYS: The Complete Picture

*(See the detailed flow diagram at the end of this document for visual representation)*

**⚠️ THE CRITICAL INSIGHT: `DOM.getFrameOwner` is THE Bridge**

Same-origin iframes have a chicken-and-egg problem:
- **FrameContextManager** gets `frameId` from CDP events but doesn't know which DOM element it is
- **DOM traversal** finds the `<iframe>` element and its `backendNodeId` but has no `frameId`
- **Solution:** `DOM.getFrameOwner(frameId)` returns the `backendNodeId` of the `<iframe>` element
- Now we can match: `frameId "ABC123"` ↔ `backendNodeId 99`

**Why We Need ensureInitialized:**
1. **Calls `Page.getFrameTree`** - Gets frames that exist at page load with their `frameId`
2. **Calls `DOM.getFrameOwner` for each frame** - THE KEY STEP: Links `frameId` → `backendNodeId`
3. **Attaches `Page.frameAttached` listener** - Catches frames that load AFTER initialization (async/dynamic iframes)
4. **Event handler ALSO calls `DOM.getFrameOwner`** - Late-loading frames get the same `frameId` → `backendNodeId` link

**Why Same-Origin Iframes Don't Have frameId (Initially):**
- `DOM.getDocument` (used by `buildBackendIdMaps`) finds the `<iframe>` tags and their content
- But Chrome doesn't populate `frameId` in DOM responses for same-origin iframes
- The `frameId` comes from CDP events (`Page.frameAttached` or `Page.getFrameTree`)
- We use `DOM.getFrameOwner(frameId)` to get the `backendNodeId`
- **backendNodeId is the bridge** that lets us match:
  - **FrameContextManager** (has `frameId` from events)
  - **frameMap** (has `iframeBackendNodeId` from DOM traversal)

**The Critical Sequence:**
```
1. ensureInitialized()
   ├─ Page.getFrameTree → frameId for existing frames
   ├─ DOM.getFrameOwner(frameId) → backendNodeId (THE LINK!)
   └─ Attach Page.frameAttached listener → frameId for async frames
                                         └─ Also calls DOM.getFrameOwner

2. buildBackendIdMaps()
   └─ DOM.getDocument({ pierce: true })
      ├─ Finds <iframe> tags → iframeBackendNodeId
      ├─ Gets contentDocument → iframe content  
      └─ NO frameId in response ❌

3. syncFrameContextManager()
   └─ Match by backendNodeId (the shared key!)
      ├─ frameMap[1].iframeBackendNodeId = 99
      ├─ FrameContextManager has { frameId: "ABC", backendNodeId: 99 }
      └─ frameMap[1].frameId = "ABC" ✅
         frameMap[1].executionContextId = 5 ✅
```

**Code References:**
- `ensureInitialized`: `src/cdp/frame-context-manager.ts` line 206
- `captureFrameTree`: `src/cdp/frame-context-manager.ts` line 227
- `populateFrameOwner`: `src/cdp/frame-context-manager.ts` line 271 (calls `DOM.getFrameOwner`)
- `handlePageFrameAttached`: `src/cdp/frame-context-manager.ts` line 458 (event handler, also calls `populateFrameOwner`)
- `syncFrameContextManager`: `src/context-providers/a11y-dom/index.ts` line 218 (matching logic)

---

### Why Event Listeners Are Essential

**What we get from initialization (`Page.getFrameTree`):**
1. ✅ `frameId` for all frames that exist at page load (main, same-origin, OOPIF)
2. ✅ Frame hierarchy and relationships
3. ✅ Initial URLs

**What's still missing (why we need events):**
1. ❌ Can't match with `DOM.getDocument` data (no `backendNodeId` yet)
2. ❌ `executionContextId` (still loading asynchronously)
3. ❌ Dynamically created iframes (added after page load by JavaScript)
4. ❌ Navigation updates (frames navigating to new URLs)

**What event listeners provide:**
1. ✅ `DOM.getFrameOwner(frameId)` → get `backendNodeId` → **bridge to DOM data!**
2. ✅ `Runtime.executionContextCreated` → get `executionContextId` → can run scripts
3. ✅ `Page.frameAttached` → capture dynamically added iframes
4. ✅ `Page.frameNavigated` → track navigations and new contexts
5. ✅ Keep state synchronized as page changes

### How We Keep Maps in Sync

Here's the lifecycle of keeping maps synchronized:

```typescript
// ========== INITIALIZATION ==========
// 1. Attach event listeners FIRST
await frameContextManager.ensureInitialized();
// - Listens to Page.frameAttached/Detached/Navigated
// - Listens to Runtime.executionContextCreated/Destroyed

// 2. THEN capture current state
const backendMaps = await buildBackendIdMaps(session);
// - Walks DOM tree (point-in-time snapshot)
// - Creates frameMap, backendNodeMap, xpathMap

// 3. Sync the two views
await syncFrameContextManager(frameContextManager, backendMaps.frameMap);
// - Matches DOM-discovered frames to CDP-tracked frames
// - Uses backendNodeId as the shared key

// ========== RUNTIME ==========
// 4. Events keep us updated
// When iframe navigates:
Page.frameNavigated event → Updates frameRecord.url
Runtime.executionContextCreated event → Updates frameExecutionContexts[frameId]

// 5. Element resolution uses latest data
const resolved = await resolveElement("1-23", context);
// - frameIndex=1 → looks up latest frameId from frameGraph
// - frameId → looks up latest executionContextId from frameExecutionContexts
// - Always uses current data, not stale snapshot
```

### Simple Timeline: How Synchronization Works

```
Step 1: ensureInitialized() - Attach event listeners
  └─ Page.frameAttached fires → frameId="ABC123"
     └─ Call DOM.getFrameOwner("ABC123") → backendNodeId=99
        └─ Store: { frameId: "ABC123", backendNodeId: 99 }

Step 2: buildBackendIdMaps() - DOM traversal
  └─ DOM.getDocument finds <iframe> → iframeBackendNodeId=99
     └─ Store: frameMap[1] = { iframeBackendNodeId: 99, frameId: undefined }

Step 3: syncFrameContextManager() - Match them!
  └─ frameMap[1].iframeBackendNodeId = 99
     └─ Match with FrameContextManager { frameId: "ABC123", backendNodeId: 99 }
        └─ Copy frameId into frameMap[1] ✅
           └─ Now complete: { frameId: "ABC123", executionContextId: 5, ... }
```

**The key:** `backendNodeId` is the shared identifier that lets us match DOM data with event data.

### The Two-Phase Sync Strategy

We use a two-phase approach to handle the async nature of frames:

**Phase 1: DOM Traversal (DOM.getDocument)**
- ✅ Captures same-origin `<iframe>` tags and their content
- ✅ Fast, synchronous tree walk
- ✅ Gets `backendNodeId` for all elements
- ❌ Missing `frameId` for same-origin iframes
- ❌ Missing `executionContextId` for all frames
- ❌ OOPIF frames are completely invisible (cross-origin blocked)

**Phase 2: Event-Driven (CDP Events)**
- ✅ Provides `frameId` via `Page.frameAttached` events
- ✅ Provides `executionContextId` via `Runtime.executionContextCreated` events
- ✅ Discovers OOPIF frames via `Target.attachedToTarget` events
- ✅ Keeps data current as frames navigate/change
- ✅ Guarantees we always have current execution context IDs

**Example of Phase 2 fixing Phase 1 gaps:**

```typescript
// Phase 1: DOM.getDocument successfully finds the iframe tag and its content
// BUT it doesn't include frameId (Chrome doesn't populate it in DOM responses)
frameMap.set(1, {
  frameIndex: 1,
  iframeBackendNodeId: 99,      // ✅ DOM traversal gave us this
  contentDocBackendNodeId: 100,  // ✅ DOM traversal gave us this
  frameId: undefined,             // ❌ Not in DOM.getDocument response!
  executionContextId: undefined   // ❌ Not in DOM.getDocument response!
});

// Phase 2: Page.frameAttached event fires
// Event: { frameId: "ABC123", parentFrameId: "ROOT" }
// We call populateFrameOwner("ABC123")
//   → DOM.getFrameOwner("ABC123") returns { backendNodeId: 99 }
// Now we can match: backendNodeId 99 = frameId "ABC123"

// syncFrameContextManager patches frameMap:
frameMap.set(1, {
  frameIndex: 1,
  frameId: "ABC123",  // ✅ Fixed!
  executionContextId: 5,  // ✅ Also added from Runtime event
  iframeBackendNodeId: 99
});
```

### Summary: Maps + Events = Synchronized State

```
┌─────────────────────────────────────────────────────────────┐
│                    Static Maps (Point-in-time)              │
├─────────────────────────────────────────────────────────────┤
│ backendNodeMap: { "1-23": 23, "1-24": 24, ... }           │
│ xpathMap: { "1-23": "//button[1]", ... }                  │
│ frameMap: Map { 1 => { frameId, iframeBackendNodeId } }   │
└─────────────────────────────────────────────────────────────┘
                            ↓ Synced via ↓
┌─────────────────────────────────────────────────────────────┐
│              Dynamic State (Event-driven)                   │
├─────────────────────────────────────────────────────────────┤
│ FrameGraph: { frameId ↔ frameIndex, hierarchy }           │
│ sessions: Map { frameId → CDPSession }                     │
│ frameExecutionContexts: Map { frameId → contextId }        │
│                                                             │
│ Updated by:                                                 │
│ - Page.frameAttached/Detached/Navigated                   │
│ - Runtime.executionContextCreated/Destroyed                │
└─────────────────────────────────────────────────────────────┘
                            ↓ Used by ↓
┌─────────────────────────────────────────────────────────────┐
│                  Element Resolution                         │
├─────────────────────────────────────────────────────────────┤
│ resolveElement("1-23") → {                                 │
│   session: CDPSession (from sessions map),                 │
│   frameId: "ABC123" (from frameGraph),                     │
│   backendNodeId: 23 (from backendNodeMap),                 │
│   executionContextId: 5 (from frameExecutionContexts)      │
│ }                                                           │
└─────────────────────────────────────────────────────────────┘
```

**The entire system relies on keeping these two layers synchronized through CDP events!**

---

## 0.7. Entry Points: `page.ai()` vs `page.aiAction()`

### Quick Reference Table

| Feature | `page.ai(task)` | `page.aiAction(instruction)` |
|---------|-----------------|------------------------------|
| **Use Case** | Multi-step complex workflows | Single granular action |
| **Mode** | Visual (screenshot + overlay) | A11y tree (text-based) |
| **LLM Calls** | Multiple (agent loop) | 1 per action |
| **Speed** | Slower (image processing) | Fast (text only) |
| **Cost** | Higher (vision tokens) | Lower (text tokens) |
| **Autonomy** | Agent decides next steps | Direct execution |
| **Implementation** | `executeTask()` → `runAgentTask()` | `executeSingleAction()` → `findElementWithRetry()` |

### Code Flow: `page.ai()`

```typescript
page.ai("Find a flight from NYC to LAX")
  ↓
HyperAgent.executeTask(task, params, page)
  ↓
runAgentTask(agentCtx, taskState, params)
  ↓
Loop until complete or maxSteps:
  1. getA11yDOM(page, { mode: "visual-debug" })
     - Builds all maps (backendNodeMap, xpathMap, frameMap, elements)
     - Takes screenshot
     - Draws bounding boxes
     - Returns combined DOM state
  2. buildAgentStepMessages(domState, history)
     - Formats accessibility tree + screenshot for LLM
  3. llm.invokeStructured(messages, actionSchema)
     - LLM decides next action
     - Returns: { type: "actElement", elementId: "1-23", method: "click", params: {} }
  4. runAction(action, domState, page, ctx)
     - resolveElement("1-23") using CDP
     - dispatchCDPAction("click", ...)
  5. waitForSettledDOM(page)
     - Wait for network idle
  6. Write debug artifacts
  7. Check if task complete
```

### Code Flow: `page.aiAction()`

```typescript
page.aiAction("click the login button")
  ↓
HyperAgent.executeSingleAction(instruction, page, params)
  ↓
findElementWithRetry(instruction, page, llm, options)
  ↓
Loop up to 10 retries:
  1. getA11yDOM(page, { mode: "a11y" })
     - Builds all maps (same as page.ai)
     - NO screenshot
     - NO bounding boxes
     - Returns text-only accessibility tree
  2. buildExamineDomMessages(domState.simplified, instruction)
     - Formats accessibility tree for LLM
     - Prompt: "Find the element matching: 'click the login button'"
  3. llm.invokeStructured(messages, ExamineDomSchema)
     - LLM identifies element
     - Returns: { elementId: "0-45", method: "click", arguments: [] }
  4. If element found:
     - resolveElement("0-45") using CDP
     - dispatchCDPAction("click", ...)
     - waitForSettledDOM(page)
     - Return success
  5. If not found:
     - Retry with fresh DOM capture (page may have changed)
```

### Key Implementation Differences

| Aspect | `page.ai()` | `page.aiAction()` |
|--------|-------------|-------------------|
| **DOM Mode** | `mode: "visual-debug"` with screenshot | `mode: "a11y"` text-only |
| **LLM Prompt** | Full agent system prompt with action schema | Minimal "find element" prompt |
| **Retry Logic** | Agent loop handles retries via actions | Built-in 10x retry with DOM refresh |
| **State Management** | TaskState tracks multi-step history | Stateless single execution |
| **Error Handling** | Can recover via `thinking` action | Fails after max retries |
| **Debug Output** | Per-step debug directories | Single aiAction/ directory |

### When Each Entry Point Calls getA11yDOM

Both entry points ultimately call `getA11yDOM()`, but with different configurations:

**`page.ai()` calls:**
```typescript
await getA11yDOM(page, {
  mode: "visual-debug",        // Screenshot + bounding boxes
  drawBoundingBoxes: true,     // Visual overlay
  debugDir: "debug/uuid/step-1",
  debug: true
});
```

**`page.aiAction()` calls:**
```typescript
await getA11yDOM(page, {
  mode: "a11y",                // Text-only
  drawBoundingBoxes: false,    // No visual processing
  debugDir: "debug/aiAction",
  debug: true
});
```

**Result:** Both produce the same maps (`backendNodeMap`, `xpathMap`, `frameMap`, `elements`), but `page.ai()` additionally includes bounding boxes and screenshots.

### Shared CDP Path: After Element Found

Once either method identifies an element, they converge on the same CDP execution path:

```typescript
// Both call resolveElement() and dispatchCDPAction()
const resolved = await resolveElement(encodedId, {
  page,
  cdpClient,
  backendNodeMap,     // From getA11yDOM
  xpathMap,           // From getA11yDOM
  frameMap,           // From getA11yDOM
  frameContextManager,
  debug: true
});

await dispatchCDPAction(method, args, {
  element: resolved,
  boundingBox: domState.boundingBoxMap?.get(encodedId),
  debug: true
});
```

This means **the CDP layer (element resolution, frame management, execution contexts) is identical for both entry points**.

### Example: Same Task, Two Approaches

**Using `page.ai()` (multi-step agent):**
```typescript
await page.ai("Login with email 'test@example.com' and password 'pass123'");
// Agent executes:
// Step 1: actElement (click email field)
// Step 2: actElement (type 'test@example.com')
// Step 3: actElement (click password field)  
// Step 4: actElement (type 'pass123')
// Step 5: actElement (click login button)
// Step 6: complete
```

**Using `page.aiAction()` (explicit steps):**
```typescript
await page.aiAction("click the email field");
await page.aiAction("type 'test@example.com' into the email field");
await page.aiAction("click the password field");
await page.aiAction("type 'pass123' into the password field");
await page.aiAction("click the login button");
```

**Trade-off:**
- `page.ai()`: More autonomous, but slower and more expensive
- `page.aiAction()`: More control, faster, cheaper, but requires explicit sequencing

---

## 1. Frame & Session Infrastructure

| Function | Location | Purpose |
| --- | --- | --- |
| `getCDPClient(page: Page)` | `src/cdp/index.ts` | Lazily creates/returns a `PlaywrightCDPClient`. Each page gets one shared client so all features reuse the same `browserContext.newCDPSession` instances. |
| `PlaywrightCDPClient.acquireSession(label)` | `src/cdp/playwright-adapter.ts` | Obtains a CDP session (root or child) for tasks like screenshots or injection. Tracks lifecycle to dispose sessions when pages close. |
| `FrameContextManager.ensureInitialized()` | `src/cdp/frame-context-manager.ts` | Enumerates existing frames via `Page.getFrameTree`, registers them, attaches listeners for `Page.frameAttached/Detached/Navigated`, and enables `Runtime` so execution contexts are tracked. Without this manager we couldn’t map encoded IDs ↔ frameIds ↔ CDP sessions. |
| `FrameContextManager.trackRuntimeForSession(session)` | same file | Subscribes to `Runtime.executionContextCreated/Destroyed`. When contexts appear, it stores `frameId → executionContextId` and resolves pending waits (used by bounding boxes and element resolution). |
| `ensureFrameContextsReady(page, debug)` | `src/agent/tools/agent.ts` | Helper called before agent tasks. It retrieves the CDP client, gets/creates the frame manager, turns on debug logging if needed, and calls `ensureInitialized()`. This guarantees that by the time actions run we know every frame’s CDP session + execution context. |

**Why this matters:** Each encoded ID (e.g., `3-283`) belongs to a frame index. To interact with it via CDP we need the frame’s CDP session (root vs. OOPIF) *and* the execution context id. The frame manager is the authoritative source of that mapping.

---

## 2. A11y DOM Capture Pipeline: Building the Maps

**Entry Point:** `getA11yDOM(page, params)` in `src/context-providers/a11y-dom/index.ts`

This is the core function that builds all the maps we discussed in Section 0. Both `page.ai()` and `page.aiAction()` call this function.

### Complete Data Flow with Examples

#### Step 1: `buildBackendIdMaps(session)` - DOM Traversal

**Location:** `src/context-providers/a11y-dom/build-maps.ts`

**What it does:**
1. Calls `DOM.getDocument({ depth: -1, pierce: true })` to get the entire DOM tree
2. Performs DFS traversal, assigning sequential `frameIndex` to each iframe
3. Builds 4 core maps

**Input:** CDP session

**Output Example:**
```typescript
{
  tagNameMap: {
    "0-15": "button",
    "0-23": "input",
    "1-42": "button",  // Frame 1 button
    "1-43": "input"    // Frame 1 input
  },
  xpathMap: {
    "0-15": "//html[1]/body[1]/button[1]",
    "0-23": "//html[1]/body[1]/form[1]/input[1]",
    "1-42": "//button[1]",  // Relative to iframe document
    "1-43": "//input[1]"
  },
  backendNodeMap: {
    "0-15": 15,
    "0-23": 23,
    "1-42": 42,
    "1-43": 43
  },
  frameMap: Map {
    1 => {
      frameIndex: 1,
      src: "https://example.com/child.html",
      xpath: "//iframe[1]",
      frameId: undefined,  // ⚠️ Same-origin iframes don't have frameId yet!
      parentFrameIndex: 0,
      iframeBackendNodeId: 99,
      contentDocumentBackendNodeId: 100,
      absoluteBoundingBox: {
        x: 0, y: 200, width: 800, height: 600,
        top: 200, left: 0, right: 800, bottom: 800
      }
    }
  }
}

// ⚠️ IMPORTANT: Same-origin iframes don't have frameId during DOM traversal
// frameId will be populated later in Step 3 (syncFrameContextManager)
// after matching with FrameContextManager's Page.frameAttached events

```

**Key CDP Call:**
```typescript
// Get full DOM tree piercing into iframes
const { root } = await session.send("DOM.getDocument", {
  depth: -1,    // Unlimited depth
  pierce: true  // Include iframe contents (for main frame)
});

// For each iframe found, get its bounding box
const boxModel = await session.send("DOM.getBoxModel", {
  backendNodeId: iframeBackendNodeId
});
```

---

#### Step 1.5: The `pierce` Parameter - Handling OOPIFs vs Same-Origin

**Critical Detail:** The `pierce` parameter behaves differently for main frames vs OOPIFs.

**For Main Frame (pierce: true):**
```typescript
// Called on root session - we WANT to pierce into same-origin iframes
const maps = await buildBackendIdMaps(rootSession, 0, debug, true);
```

This captures:
- ✅ Main frame content
- ✅ Same-origin iframes (contentDocument present)
- ❌ **NOT** cross-origin iframes (blocked by browser security)

**For OOPIF Frames (pierce: false):**
```typescript
// Called on OOPIF session - we DON'T want to pierce nested iframes
const subMaps = await buildBackendIdMaps(oopifSession, frameIndex, debug, false);
```

**Why pierce: false for OOPIFs?**

1. **Prevents "Zombie Frame" Bug:** OOPIFs in transitional states may show temporary same-origin nested iframes (e.g., ad frames injecting `about:blank` then navigating). Using `pierce: true` would capture these transient frames, creating incorrect deep nesting.

2. **Legitimate Nested OOPIFs Get Their Own Sessions:** Any real nested cross-origin iframe will be discovered via CDP Target events and get its own session. We don't need to pierce to find them.

3. **Performance:** Avoids processing iframes that will disappear or become separate OOPIFs anyway.

**Example: Ad Frame Transitional State**
```
Main Frame
  └─ OOPIF Frame (ads.example.com)
       └─ <iframe src="about:blank">  ← Temporary! Will navigate to another origin
            └─ <iframe>  ← Ghost nested frame
                 └─ <iframe>  ← Ghost nested frame
```

If we use `pierce: true` on the OOPIF session, we'd capture all these ghost frames. With `pierce: false`, we correctly ignore them.

**Location in Code:** `src/context-providers/a11y-dom/index.ts` (collectCrossOriginFrameData function)

---

#### Step 2: `fetchIframeAXTrees()` - Accessibility Data

**What it does:** Fetches the accessibility tree for each frame

**Input:** `frameMap` from step 1

**CDP Call:**
```typescript
// For main frame:
const mainAXTree = await session.send("Accessibility.getFullAXTree");

// For each iframe:
const iframeAXTree = await session.send("Accessibility.getPartialAXTree", {
  backendNodeId: frameInfo.contentDocumentBackendNodeId
});
```

**Output Example:** Array of AX trees, one per frame
```typescript
[
  {
    frameIndex: 0,
    nodes: [
      {
        nodeId: "ax-1",
        role: { value: "WebArea" },
        childIds: ["ax-2", "ax-3"]
      },
      {
        nodeId: "ax-2",
        role: { value: "button" },
        name: { value: "Login" },
        backendDOMNodeId: 15  // Matches backendNodeMap!
      },
      {
        nodeId: "ax-3",
        role: { value: "textbox" },
        name: { value: "Email" },
        backendDOMNodeId: 23
      }
    ]
  },
  {
    frameIndex: 1,
    nodes: [
      {
        nodeId: "ax-10",
        role: { value: "button" },
        name: { value: "I'm in an iframe" },
        backendDOMNodeId: 42  // Frame 1's node
      }
    ]
  }
]
```

---

#### Step 2.5: Performance Optimization - Parallel Same-Origin Processing

**Prior Implementation: Sequential Processing**

Originally, same-origin iframes were processed one-by-one in a `for` loop:

```typescript
// ❌ Old approach: Sequential
for (const [frameIndex, iframeInfo] of Array.from(sameOriginFramesToProcess)) {
  await annotateFrameSessions(...);
  const axTree = await session.send("Accessibility.getPartialAXTree", {...});
  // ... process tree
}
```

**Problem:** Each iframe had to wait for the previous one to complete. On a page with 6 iframes, this could take ~1.9 seconds.

**Optimized Implementation: Parallel Processing**

Now all same-origin iframes are processed concurrently using `Promise.all`:

```typescript
// ✅ New approach: Parallel
await Promise.all(
  Array.from(sameOriginFramesToProcess).map(async ([frameIndex, iframeInfo]) => {
    await annotateFrameSessions(...);
    const axTree = await session.send("Accessibility.getPartialAXTree", {...});
    // ... process tree
  })
);
```

**Performance Impact:**

| Configuration | Sequential Time | Parallel Time | Savings |
|---------------|----------------|---------------|---------|
| 3 iframes     | ~1929ms        | ~1520ms       | **409ms (21%)** |
| 6 iframes     | ~1929ms        | ~1715ms       | **214ms (11%)** |
| 7 iframes     | ~2100ms        | ~1734ms       | **366ms (17%)** |

**Why This Is Safe:**

1. **Hierarchy Is Pre-Established:** The parent-child relationships are already determined during DOM traversal (Step 1). Each iframe has its `parentFrameIndex` set.

2. **Independent CDP Sessions:** Same-origin iframes all use the root CDP session, which can handle multiple concurrent requests.

3. **No Shared State Mutations:** Each iframe's processing is isolated - they write to different keys in the maps.

4. **Tree Building Happens Later:** The hierarchical tree assembly (Step 4) happens after all parallel work completes, using the pre-established hierarchy from `frameMap`.

**Example Processing Flow:**

```
Main Frame (frameIndex 0)
├─ iframe 1 (parent: 0) ┐
├─ iframe 2 (parent: 0) ├─ All process in parallel
├─ iframe 3 (parent: 0) │  No blocking!
└─ iframe 4 (parent: 0) ┘

After Promise.all completes → Step 3 (sync) → Step 4 (build tree)
```

**Location in Code:** `src/context-providers/a11y-dom/index.ts` (fetchIframeAXTrees function)

**Note:** OOPIFs are still processed sequentially because they require separate CDP session setup, but this is much rarer (typically 0-2 OOPIFs per page vs 3-7 same-origin iframes).

---

#### Step 3: `syncFrameContextManager()` - Connect DOM and CDP Views

**What it does:** Merges `frameMap` (from DOM) with `FrameContextManager` (from events)

**⚠️ CRITICAL TIMING:** This step requires waiting for `Page.frameAttached` events to fire!

**Why Same-Origin Iframes Don't Have `frameId` Initially:**

During DOM traversal (Step 1), when we call `DOM.getDocument({ pierce: true })`, Chrome returns:
- ✅ `backendNodeId` for the `<iframe>` element
- ✅ `contentDocument` with the iframe's DOM tree
- ❌ **NO `frameId`** in the response

**This is normal and expected behavior** in modern Chromium. The `frameId` comes from a **separate event-driven system**.

**The Two-Phase Discovery Process:**

**Phase 1: DOM Traversal (buildBackendIdMaps)**
```typescript
// What we know after Step 1:
{
  frameIndex: 1,
  iframeBackendNodeId: 99,           // ✅ From DOM.getDocument
  contentDocumentBackendNodeId: 100, // ✅ From DOM.getDocument
  frameId: undefined,                // ❌ NOT in DOM response
  executionContextId: undefined      // ❌ NOT in DOM response
}
```

**Phase 2: Event-Driven Discovery (FrameContextManager)**

When the page loads, `FrameContextManager` listens to CDP events:
```typescript
// Event fired by Chrome when iframe navigates:
Page.frameAttached({
  frameId: "ABC123",          // ✅ Chrome's frame identifier
  parentFrameId: "MAIN_FRAME"
})

// FrameContextManager calls DOM.getFrameOwner to get backendNodeId:
const { backendNodeId } = await session.send("DOM.getFrameOwner", {
  frameId: "ABC123"
});
// Returns: { backendNodeId: 99 } ← THE LINK!

// Later, execution context is created:
Runtime.executionContextCreated({
  context: {
    id: 5,               // ✅ Execution context ID
    auxData: {
      frameId: "ABC123"  // Links context to frame
    }
  }
})
```

**⏳ Synchronization Point: syncFrameContextManager**

This function **waits** for the event-driven data to be available, then merges it:

```typescript
async function syncFrameContextManager({ manager, frameMap }) {
  for (const [frameIndex, iframeInfo] of frameMap.entries()) {
    // Match by backendNodeId (the shared key!)
    const frameRecord = manager.getFrameByBackendNodeId(
      iframeInfo.iframeBackendNodeId  // 99
    );
    
    if (frameRecord) {
      // ✅ Now we can populate frameId and executionContextId!
      iframeInfo.frameId = frameRecord.frameId; // "ABC123"
      iframeInfo.executionContextId = manager.getExecutionContextId(
        frameRecord.frameId
      ); // 5
      
      // Also overwrite the preliminary frameIndex from FrameContextManager
      // with the authoritative DOM traversal order:
      manager.assignFrameIndex(frameRecord.frameId, frameIndex);
    } else {
      // No match = transitional/unmatched frame (typically ads)
      console.log(`[A11y] Unmatched iframe at frameIndex ${frameIndex}`);
    }
  }
}
```

**After Synchronization:**
```typescript
{
  frameIndex: 1,
  iframeBackendNodeId: 99,           // ✅ From DOM
  contentDocumentBackendNodeId: 100, // ✅ From DOM
  frameId: "ABC123",                 // ✅ From Page.frameAttached event
  executionContextId: 5              // ✅ From Runtime.executionContextCreated event
}
```

**Result:** `frameMap` now has complete data from both DOM traversal and CDP events!

**Why This Timing Matters:**

If we try to use `frameId` or `executionContextId` before this sync completes, they'll be `undefined` and actions will fail. This is why `getA11yDOM` calls `syncFrameContextManager` after building the maps but before returning the final state.

---

#### Step 4: `buildHierarchicalTree()` - Merge Everything

**What it does:** Combines accessibility tree + DOM maps + bounding boxes

**Input:**
- AX nodes from step 2
- Maps from step 1
- `frameMap` from step 3 (now complete)

**Processing:**
```typescript
// For each AX node with a backendDOMNodeId:
const encodedId = createEncodedId(frameIndex, node.backendDOMNodeId);

const accessibilityNode: AccessibilityNode = {
  role: node.role.value,
  name: node.name?.value,
  backendDOMNodeId: node.backendDOMNodeId,
  encodedId: encodedId  // ← The key that ties everything together!
};

// Store in elements map
elements.set(encodedId, accessibilityNode);
```

**Output Example:**
```typescript
{
  tree: [
    {
      role: "button",
      name: "Login",
      backendDOMNodeId: 15,
      encodedId: "0-15"
    },
    {
      role: "textbox",
      name: "Email",
      backendDOMNodeId: 23,
      encodedId: "0-23"
    }
  ],
  simplified: `
[0-15] button "Login"
[0-23] textbox "Email"

Frame 1 (https://example.com/child.html):
[1-42] button "I'm in an iframe"
[1-43] textbox "Password"
  `,
  boundingBoxMap: Map {
    "0-15" => { x: 100, y: 200, width: 80, height: 40, ... },
    "0-23" => { x: 100, y: 250, width: 200, height: 30, ... },
    "1-42" => { x: 50, y: 500, width: 100, height: 35, ... }, // Already translated!
  }
}
```

---

#### Step 5: Return Complete `A11yDOMState`

**Final Result:**
```typescript
interface A11yDOMState {
  // For LLM consumption
  simplified: string;                     // Text representation
  elements: Map<EncodedId, AccessibilityNode>;  // Full element data
  
  // For element resolution
  backendNodeMap: Record<EncodedId, number>;    // encodedId → backendNodeId
  xpathMap: Record<EncodedId, string>;          // encodedId → XPath
  frameMap: Map<number, IframeInfo>;            // frameIndex → metadata
  
  // For visual mode
  boundingBoxMap?: Map<EncodedId, DOMRect>;     // encodedId → coordinates
  overlayImage?: Buffer;                         // Debug visualization
  
  // Debug info
  domState: string;  // Raw simplified tree
  screenshot?: Buffer;
}
```

**This is what gets cached and passed to the LLM and element resolver!**

---

### Why This Multi-Step Process?

You might wonder: why not get everything in one CDP call?

**Answer:** Chrome's CDP domains are isolated:
- **DOM domain** gives us structure (tags, XPath, backendNodeId)
- **Accessibility domain** gives us semantics (roles, names, values)
- **Page domain** gives us frames (frameId, hierarchy)
- **Runtime domain** gives us execution contexts (contextId)

We have to call each domain separately and stitch the results together using shared keys like `backendNodeId` and `frameId`.

---

## 3. Bounding Box Collection: How We Get Element Coordinates

**Used by:** `page.ai()` visual mode only (not `page.aiAction()`)

### The Challenge

We need pixel-perfect coordinates to:
1. Draw visual overlays showing which elements are interactive
2. Send precise mouse coordinates to `Input.dispatchMouseEvent`
3. Translate iframe element coordinates to main viewport coordinates

### The Solution: JavaScript Injection + XPath Evaluation

We inject a helper script into each frame's execution context that can:
1. Accept a map of `XPath → backendNodeId`
2. Evaluate XPath to find the DOM element
3. Call `getBoundingClientRect()` on each element
4. Return all coordinates in one batch

### Step-by-Step Process

#### Step 1: Inject the Script

**Function:** `ensureScriptInjected(session, key, script, executionContextId)`

**What it does:** Injects JavaScript into a specific execution context (frame)

**CDP Call:**
```typescript
await session.send("Runtime.evaluate", {
  expression: `
    window.__hyperagent_collectBoundingBoxesByXPath = function(xpathToBackendId) {
      const results = {};
      for (const [xpath, backendNodeId] of Object.entries(xpathToBackendId)) {
        try {
          const result = document.evaluate(
            xpath, 
            document, 
            null, 
            XPathResult.FIRST_ORDERED_NODE_TYPE, 
            null
          );
          const element = result.singleNodeValue;
          if (element && element.getBoundingClientRect) {
            const rect = element.getBoundingClientRect();
            results[backendNodeId] = {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
              top: rect.top,
              left: rect.left,
              right: rect.right,
              bottom: rect.bottom
            };
          }
        } catch (err) {
          // XPath evaluation failed, skip this element
        }
      }
      return results;
    };
  `,
  contextId: executionContextId,  // ← Must match the frame!
  returnByValue: false
});
```

**Why per-context?** Each frame (iframe) has its own JavaScript context. A script injected into the main frame can't access iframe DOMs due to browser security. We must inject the script into each frame's context separately.

**Caching:** We track `(session, contextId) → injected` so we don't re-inject unnecessarily.

---

#### Step 2: Batch Collect Bounding Boxes

**Function:** `batchCollectBoundingBoxesViaCDP(session, executionContextId, xpathMap, frameIndex, ...)`

**Input:** List of elements we need boxes for

**Example input:**
```typescript
{
  "//button[1]": 42,  // XPath → backendNodeId
  "//input[1]": 43,
  "//a[1]": 44
}
```

**CDP Call:**
```typescript
const result = await session.send("Runtime.evaluate", {
  expression: `window.__hyperagent_collectBoundingBoxesByXPath(${JSON.stringify(xpathToBackendIdMap)})`,
  contextId: executionContextId,
  returnByValue: true,  // ← Get the actual object back
  awaitPromise: false
});

// result.result.value contains:
{
  "42": { x: 50, y: 100, width: 100, height: 35, ... },
  "43": { x: 50, y: 150, width: 200, height: 30, ... },
  "44": { x: 50, y: 200, width: 150, height: 25, ... }
}
```

**Convert to encodedId map:**
```typescript
const boundingBoxMap = new Map<EncodedId, DOMRect>();

for (const [backendNodeId, rect] of Object.entries(result)) {
  const encodedId = createEncodedId(frameIndex, Number(backendNodeId));
  boundingBoxMap.set(encodedId, rect);
}

// Result:
Map {
  "1-42" => { x: 50, y: 100, width: 100, height: 35, ... },
  "1-43" => { x: 50, y: 150, width: 200, height: 30, ... },
  "1-44" => { x: 50, y: 200, width: 150, height: 25, ... }
}
```

---

#### Step 3: Translate Iframe Coordinates

**Problem:** Coordinates from `getBoundingClientRect()` in an iframe are relative to the iframe's viewport, not the main page viewport.

**Example:**
```
Main page (0,0)
├─ Button at (100, 200)  ← These coordinates are relative to main page
├─ Iframe at (0, 400), size 800x600
│  ├─ Button at (50, 100)  ← These are relative to iframe!
│  │  Actual position in main viewport: (0+50, 400+100) = (50, 500)
```

**Solution:** Add iframe's offset to each element's coordinates

```typescript
if (frameIndex !== 0 && frameInfo.absoluteBoundingBox) {
  // frameInfo.absoluteBoundingBox came from Step 1 of Section 2
  const iframeOffset = {
    x: frameInfo.absoluteBoundingBox.x,
    y: frameInfo.absoluteBoundingBox.y
  };
  
  for (const [encodedId, rect] of boundingBoxMap.entries()) {
    rect.x += iframeOffset.x;
    rect.y += iframeOffset.y;
    rect.left += iframeOffset.x;
    rect.right += iframeOffset.x;
    rect.top += iframeOffset.y;
    rect.bottom += iframeOffset.y;
  }
}
```

**After translation:**
```typescript
Map {
  "1-42" => { x: 50, y: 500, ... },  // Translated from (50, 100)
  "1-43" => { x: 50, y: 550, ... },  // Translated from (50, 150)
}
```

Now when we draw overlays or send mouse clicks, the coordinates are correct relative to the main viewport!

---

### Why This Matters: Visual Debugging

The translated bounding boxes enable:

1. **Visual Overlays:** Draw rectangles on screenshot showing interactive elements
2. **Precise Clicks:** Send mouse events to exact pixel coordinates
3. **Debugging:** See which elements the agent can interact with

**Example overlay rendering:**
```typescript
// For each element with a bounding box
for (const [encodedId, rect] of boundingBoxMap.entries()) {
  const elem = elements.get(encodedId);
  
  // Draw rectangle on transparent image
  ctx.strokeStyle = 'red';
  ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
  
  // Draw label
  ctx.fillStyle = 'white';
  ctx.fillText(encodedId, rect.x + 2, rect.y + 12);
}
```

Result: Screenshot with red boxes and labels showing `"0-15"`, `"1-42"`, etc.

---

## 4. Element Resolution & Action Dispatch

**Note:** For a high-level comparison of `page.ai()` vs `page.aiAction()`, see **Section 0.7**.

This section covers the implementation details of how we go from `encodedId` to actual CDP commands.

### 4.1 Element Resolution: `resolveElement(encodedId, context)`

**Location:** `src/cdp/element-resolver.ts`

**Purpose:** Convert `encodedId` (e.g., `"1-42"`) into a `ResolvedCDPElement` with everything needed to interact with it.

**Input:**
```typescript
encodedId: "1-42"
context: {
  page,
  cdpClient,
  backendNodeMap: { "1-42": 42 },
  xpathMap: { "1-42": "//button[1]" },
  frameMap: Map { 1 => IframeInfo },
  frameContextManager,
  debug: true
}
```

**Step-by-step process:**

1. **Parse frame index**
   ```typescript
   const frameIndex = parseFrameIndex("1-42");  // → 1
   ```

2. **Look up frame metadata**
   ```typescript
   const frameInfo = frameMap.get(1);
   // frameInfo = { frameId: "ABC123", parentFrameIndex: 0, ... }
   ```

3. **Get CDP session**
   ```typescript
   const frameId = frameInfo.frameId || frameContextManager.getFrameIdByIndex(1);
   const session = frameContextManager.getFrameSession(frameId);
   // session = CDP session for this frame
   ```

4. **Get execution context ID**
   ```typescript
   const executionContextId = frameContextManager.getExecutionContextId(frameId);
   // executionContextId = 5 (from Runtime.executionContextCreated event)
   ```

5. **Get backendNodeId**
   ```typescript
   let backendNodeId = backendNodeMap["1-42"];  // → 42
   ```

6. **Resolve to object ID (for interaction)**
   ```typescript
   const resolved = await session.send("DOM.resolveNode", {
     backendNodeId: 42
   });
   // resolved.object.objectId = "remote-object-123"
   ```

**Output:**
```typescript
{
  session: CDPSession,           // To send commands
  frameId: "ABC123",            // Which frame
  backendNodeId: 42,            // DOM node ID
  objectId: "remote-object-123" // JavaScript object handle
}
```

**Fallback: XPath Recovery**

If step 6 fails (element became stale), we recover using XPath:

```typescript
// Get XPath from our map
const xpath = xpathMap["1-42"];  // "//button[1]"

// Evaluate XPath in the correct execution context
const evalResult = await session.send("Runtime.evaluate", {
  expression: `
    (function() {
      const result = document.evaluate("//button[1]", document, null, 
        XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      return result.singleNodeValue;
    })()
  `,
  contextId: executionContextId,  // ← Critical! Must match the frame
  returnByValue: false
});

// Get the new backendNodeId
const description = await session.send("DOM.describeNode", {
  objectId: evalResult.result.objectId
});

// Update our cache
backendNodeMap["1-42"] = description.node.backendNodeId;  // New ID!
```

**Why this works:** XPath is relative to the document and remains valid even when `backendNodeId` changes. The `executionContextId` ensures we evaluate in the correct frame.

---

### 4.2 Action Dispatch: `dispatchCDPAction(method, args, context)`

**Location:** `src/cdp/interactions.ts`

**Purpose:** Execute the actual browser action using CDP commands.

**Input:**
```typescript
method: "click"
args: []
context: {
  element: ResolvedCDPElement,  // From resolveElement()
  boundingBox: { x: 50, y: 500, width: 100, height: 35 },
  debug: true
}
```

**Example: Click Action**

```typescript
async function clickElement(ctx: CDPActionContext) {
  const { session, backendNodeId } = ctx.element;
  
  // Step 1: Scroll element into view
  await session.send("DOM.scrollIntoViewIfNeeded", {
    backendNodeId
  });
  
  // Step 2: Get effective bounding box
  // (Use provided box or query from CDP)
  let box = ctx.boundingBox;
  if (!box) {
    const boxModel = await session.send("DOM.getBoxModel", {
      backendNodeId
    });
    box = computeRectFromQuad(boxModel.model.border);
  }
  
  // Step 3: Compute click position (center of element)
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  
  // Step 4: Send mouse events
  await session.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x, y
  });
  
  await session.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x, y,
    button: "left",
    clickCount: 1
  });
  
  await session.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x, y,
    button: "left",
    clickCount: 1
  });
  
  if (ctx.debug) {
    console.log(`[CDP] Clicked at (${x}, ${y})`);
  }
}
```

**Debug output:**
```
[CDP] Clicked at (100, 525)
```

---

### 4.3 DOM Settlement: `waitForSettledDOM(page)`

**Location:** `src/utils/waitForSettledDOM.ts`

**Purpose:** Wait for page to stop changing after an action (navigation, AJAX, etc.)

**How it works:**

```typescript
async function waitForSettledDOM(page: Page) {
  const cdpClient = await getCDPClient(page);
  const session = cdpClient.rootSession;
  
  // Track in-flight network requests
  const pendingRequests = new Set<string>();
  
  // Listen to network events
  await session.send("Network.enable");
  
  session.on("Network.requestWillBeSent", (params) => {
    pendingRequests.add(params.requestId);
  });
  
  session.on("Network.loadingFinished", (params) => {
    pendingRequests.delete(params.requestId);
  });
  
  session.on("Network.loadingFailed", (params) => {
    pendingRequests.delete(params.requestId);
  });
  
  // Wait until idle
  await new Promise((resolve) => {
    const checkIdle = setInterval(() => {
      if (pendingRequests.size === 0) {
        clearInterval(checkIdle);
        resolve();
      }
    }, 100);
    
    // Timeout after 5 seconds
    setTimeout(() => {
      clearInterval(checkIdle);
      resolve();
    }, 5000);
  });
  
  // Return statistics
  return {
    finalPendingCount: pendingRequests.size,
    settlementDuration: Date.now() - startTime
  };
}
```

**Why this matters:** After clicking a button, the page might:
- Navigate to a new URL
- Load content via AJAX
- Update the DOM dynamically

We need to wait for stability before capturing the new DOM state for the next agent step.

---

## 5. CDP Runtime Actions: Complete Action Catalog

**Location:** `src/cdp/interactions.ts`

This section shows the actual CDP commands sent for each action type. All functions follow the pattern:
1. Get resolved element from context
2. Ensure prerequisites (focus, scroll into view, etc.)
3. Send CDP commands
4. Wait for effects to settle

---

### 5.1 `clickElement(ctx, options)`

**Purpose:** Click an element (supports double-click, right-click, etc.)

**CDP Commands Sequence:**
```typescript
// 1. Scroll into view
await session.send("DOM.scrollIntoViewIfNeeded", {
  backendNodeId: 42
});

// 2. Get bounding box
const { model } = await session.send("DOM.getBoxModel", {
  backendNodeId: 42
});
// model.border = [x1, y1, x2, y2, x3, y3, x4, y4] (quad)

// 3. Compute center point
const x = 150;  // Center of bounding box
const y = 225;

// 4. Move mouse
await session.send("Input.dispatchMouseEvent", {
  type: "mouseMoved",
  x: 150,
  y: 225
});

// 5. Press mouse button
await session.send("Input.dispatchMouseEvent", {
  type: "mousePressed",
  x: 150,
  y: 225,
  button: "left",  // or "right" for context menu
  clickCount: 1    // or 2 for double-click
});

// 6. Release mouse button
await session.send("Input.dispatchMouseEvent", {
  type: "mouseReleased",
  x: 150,
  y: 225,
  button: "left",
  clickCount: 1
});
```

---

### 5.2 `typeText(ctx, text, options)`

**Purpose:** Type text into a focused element

**CDP Commands:**
```typescript
// 1. Focus the element first
await session.send("Runtime.callFunctionOn", {
  objectId: "remote-object-123",
  functionDeclaration: "function() { this.focus(); }"
});

// 2. Insert text using Input domain
await session.send("Input.insertText", {
  text: "hello@example.com"
});

// 3. Optional: Press Enter to submit
if (options.commitEnter) {
  await session.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    code: "Enter"
  });
  
  await session.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter"
  });
}
```

**Note:** `Input.insertText` is faster than simulating individual keystrokes but doesn't trigger `keydown`/`keypress` events. For forms that validate on keystroke, use `pressKey` in a loop instead.

---

### 5.3 `fillElement(ctx, value)`

**Purpose:** Set an input's value directly (bypasses typing simulation)

**CDP Commands:**
```typescript
// 1. Focus element
await session.send("Runtime.callFunctionOn", {
  objectId: "remote-object-123",
  functionDeclaration: "function() { this.focus(); }"
});

// 2. Set value directly via JavaScript
await session.send("Runtime.callFunctionOn", {
  objectId: "remote-object-123",
  functionDeclaration: `function() { 
    this.value = "hello@example.com";
    this.dispatchEvent(new Event('input', { bubbles: true }));
    this.dispatchEvent(new Event('change', { bubbles: true }));
  }`
});

// 3. Optional: Press Enter
if (options.commitEnter) {
  // Same as typeText
}
```

**When to use:** `fillElement` is much faster than `typeText` and works for most forms. Use `typeText` only when the site validates during typing (e.g., autocomplete, live search).

---

### 5.4 `selectOption(ctx, { value })`

**Purpose:** Select an option in a `<select>` dropdown

**CDP Commands:**
```typescript
// Execute script inside the select element
await session.send("Runtime.callFunctionOn", {
  objectId: "remote-object-123",  // The <select> element
  functionDeclaration: `function(targetValue) {
    // Find option by value or text
    const options = Array.from(this.options);
    const match = options.find(opt => 
      opt.value === targetValue || opt.text === targetValue
    );
    
    if (match) {
      this.value = match.value;
      match.selected = true;
      this.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    return false;
  }`,
  arguments: [{ value: "california" }]
});
```

**Example HTML:**
```html
<select id="state">
  <option value="ca">California</option>
  <option value="ny">New York</option>
</select>
```

**Works with both:**
- `selectOption(ctx, { value: "ca" })` → Matches by value
- `selectOption(ctx, { value: "California" })` → Matches by text

---

### 5.5 `setChecked(ctx, checked)`

**Purpose:** Check or uncheck a checkbox/radio button

**CDP Commands:**
```typescript
await session.send("Runtime.callFunctionOn", {
  objectId: "remote-object-123",
  functionDeclaration: `function(shouldCheck) {
    this.checked = shouldCheck;
    this.dispatchEvent(new Event('change', { bubbles: true }));
    this.dispatchEvent(new Event('input', { bubbles: true }));
  }`,
  arguments: [{ value: true }]  // or false to uncheck
});
```

---

### 5.6 `scrollToPosition(ctx, { percent })`

**Purpose:** Scroll a scrollable element to a specific percentage

**CDP Commands:**
```typescript
// Execute scroll script in the element's context
await session.send("Runtime.callFunctionOn", {
  objectId: "remote-object-123",
  functionDeclaration: `async function(targetPercent) {
    const maxScroll = this.scrollHeight - this.clientHeight;
    const targetPosition = (maxScroll * targetPercent) / 100;
    
    // Smooth scroll
    this.scrollTo({
      top: targetPosition,
      behavior: 'smooth'
    });
    
    // Wait for scroll to settle
    return new Promise((resolve) => {
      let lastPosition = this.scrollTop;
      let stableCount = 0;
      const requiredStableFrames = 3;
      
      const check = () => {
        const currentPosition = this.scrollTop;
        const delta = Math.abs(currentPosition - lastPosition);
        
        if (delta < 1) {
          stableCount++;
          if (stableCount >= requiredStableFrames) {
            resolve({
              status: 'done',
              finalPosition: currentPosition,
              targetPosition: targetPosition
            });
            return;
          }
        } else {
          stableCount = 0;
        }
        
        lastPosition = currentPosition;
        requestAnimationFrame(check);
      };
      
      requestAnimationFrame(check);
    });
  }`,
  arguments: [{ value: 75 }],  // Scroll to 75%
  awaitPromise: true
});
```

**Why `requestAnimationFrame`?** Smooth scrolling is asynchronous. We need to wait for the animation to complete before declaring the scroll "done".

---

### 5.7 `pressKey(ctx, key)`

**Purpose:** Simulate pressing a keyboard key

**CDP Commands:**
```typescript
// Key down
await session.send("Input.dispatchKeyEvent", {
  type: "keyDown",
  key: "Enter",
  code: "Enter",
  text: "\r",  // For Enter key
  windowsVirtualKeyCode: 13,  // Enter's key code
  nativeVirtualKeyCode: 13
});

// Key up
await session.send("Input.dispatchKeyEvent", {
  type: "keyUp",
  key: "Enter",
  code: "Enter",
  windowsVirtualKeyCode: 13,
  nativeVirtualKeyCode: 13
});
```

**Common keys:**
- `"Enter"` → Submit forms
- `"Escape"` → Close modals
- `"Tab"` → Navigate between fields
- `"ArrowDown"` → Open dropdown menus

---

### Summary: CDP Command Mapping

| **Action** | **Primary CDP Command** | **Use Case** |
|-----------|-------------------------|--------------|
| **click** | `Input.dispatchMouseEvent` | Buttons, links, any clickable element |
| **type** | `Input.insertText` | Search boxes, chat inputs, forms |
| **fill** | `Runtime.callFunctionOn` + `.value =` | Fast form filling |
| **select** | `Runtime.callFunctionOn` on `<select>` | Dropdowns |
| **check** | `Runtime.callFunctionOn` + `.checked =` | Checkboxes, radios |
| **scroll** | `Runtime.callFunctionOn` + `.scrollTo()` | Infinite scroll, pagination |
| **pressKey** | `Input.dispatchKeyEvent` | Submit, escape, navigate |

All actions rely on `ensureRuntimeEnabled(session)` to enable the Runtime domain for JavaScript evaluation.

---

## 6. Quick Reference: Function Call Order

1. `runAgentTask`
   - `ensureFrameContextsReady`
   - For each step:
     1. `getA11yDOM`
        - `buildBackendIdMaps`
        - `buildHierarchicalTree`
        - `batchCollectBoundingBoxesWithFailures`
     2. `llm.invokeStructured`
     3. `runAction`
        - `ctx.cdp!.resolveElement`
        - `dispatchCDPAction`
          - e.g., `scrollToElement` → `scrollElementIntoView`
     4. `waitForSettledDOM`
     5. Debug writes (frames.json, perf.json, overlay, etc.)
2. `executeSingleAction` (short path)
   - `ctx.cdp!.resolveElement`
   - `dispatchCDPAction`
   - `waitForSettledDOM`

Use this as a map when you’re stepping through a debugger or reviewing logs.

## Appendix: Additional Implementation Notes

### A. FrameContextManager Implementation Details

**Key Classes:**

```typescript
class FrameContextManager {
  private graph: FrameGraph;                           // Frame hierarchy
  private sessions: Map<string, CDPSession>;           // frameId → session
  private frameExecutionContexts: Map<string, number>; // frameId → contextId
  
  // Key methods covered in Section 0.6:
  upsertFrame(input: { frameId, parentFrameId, url?, ... }): FrameRecord;
  setFrameSession(frameId: string, session: CDPSession): void;
  getExecutionContextId(frameId: string): number | undefined;
  waitForExecutionContext(frameId: string): Promise<number | undefined>;
}
```

**Initialization sequence:** See Section 0.6 for detailed event synchronization flow.

### B. Known Edge Cases & Workarounds

1. **Same-Origin Iframes Missing `frameId` (Expected Behavior):**
   - **Observation:** During DOM traversal, `contentDocument.frameId` is `undefined` for same-origin iframes in modern Chromium
   - **This is NOT a bug:** `frameId` comes from `Page.frameAttached` events, not DOM responses
   - **Solution:** Match frames using `backendNodeId` in `syncFrameContextManager` after waiting for CDP events (see Section 2, Step 3)
   - **Critical:** Must wait for `Page.frameAttached` events to fire before attempting to use `frameId` or `executionContextId`

2. **Stale `backendNodeId` after navigation:**
   - DOM mutations invalidate backend node IDs
   - **Solution:** XPath fallback (see Section 4.1)

3. **OOPIF session management:**
   - Cross-origin iframes require separate CDP sessions
   - **Solution:** Track OOPIF set in FrameContextManager, route commands to correct session

4. **Execution context timing:**
   - `Runtime.executionContextCreated` might not fire if Runtime domain isn't enabled
   - **Solution:** `trackRuntimeForSession` enables it immediately when session is registered

5. **Transitional/Loading Cross-Origin Iframes:**
   - **Observation:** Iframes may appear in DOM with `contentDocument` but no `frameId` match in FrameContextManager
   - **Cause:** Iframe started same-origin (e.g., `about:blank`) but is navigating to cross-origin URL
   - **Common scenario:** Ad frames that inject themselves then navigate
   - **Solution:** Log as "unmatched" and exclude from tree. They'll either:
     - Complete navigation and become proper OOPIFs (discovered via Target events)
     - Remain ephemeral and don't need to be interactive
   - **Not a bug:** These are correctly excluded; attempting to interact with transitional frames would fail

6. **"Zombie Frame" Bug - FIXED:**
   - **Prior bug:** OOPIF frames showed deeply nested identical child frames (e.g., frames 9-13 all with same content)
   - **Root cause:** `buildBackendIdMaps` was called with `pierce: true` for OOPIFs, capturing transient nested iframes in transitional states
   - **Fix:** Use `pierce: false` when calling `buildBackendIdMaps` for OOPIF sessions (see Section 2, Step 1.5)
   - **Rationale:** Legitimate nested OOPIFs get their own CDP sessions via Target events; piercing only captures ghosts
   - **Location:** `src/context-providers/a11y-dom/index.ts` (collectCrossOriginFrameData)

7. **Missing `backendNodeMap` for OOPIF Elements - FIXED:**
   - **Prior bug:** XPath recovery was triggered unnecessarily for OOPIF elements even though `backendNodeId` was known
   - **Root cause:** `backendNodeMap` from OOPIF `buildBackendIdMaps` wasn't being merged into main maps
   - **Fix:** Added `Object.assign(maps.backendNodeMap, subMaps.backendNodeMap)` in `collectCrossOriginFrameData`
   - **Impact:** Eliminated unnecessary XPath evaluation overhead for OOPIF interactions
   - **Location:** `src/context-providers/a11y-dom/index.ts` line ~727

### C. Future Improvements

1. **Bounding Box Translation Helper**
   - Extract iframe coordinate translation into dedicated function
   - Current: inline in `batchCollectBoundingBoxesViaCDP`

2. **Script Injection Error Propagation**
   - Currently logs warnings but doesn't propagate failures
   - Consider returning status so callers can fallback

3. **Scroll Method Consolidation**
   - Legacy `scrollTo` should be deprecated in favor of explicit `scrollToElement`/`scrollToPercentage`

4. **Frame Map Threading**
   - Many functions pass `frameMap` as parameter
   - Consider storing in context object to reduce parameter passing

For the most up-to-date synchronization details, see **Section 0.6: The Synchronization Challenge**.

---

## Complete Flow Diagram: From Page Load to LLM Call

This diagram shows the complete data collection pipeline, including frame handling, synchronization points, and data structure assembly.

### Legend

```
┌─────────┐
│ Process │  = Action/Process
└─────────┘

[Data]      = Data Structure

⏳ WAIT     = Synchronization Point

═══════════  = Main Data Flow
───────────  = Event Flow
┈┈┈┈┈┈┈┈┈┈┈  = Optional/Conditional Flow
```

---

### Phase 1: Initialization & Event Listener Setup

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        Agent Task Starts                                 │
│                    (page.ai() or page.aiAction())                       │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
                                 ▼
                    ┌────────────────────────┐
                    │ ensureFrameContexts    │
                    │       Ready()          │
                    └───────────┬────────────┘
                                │
                                ▼
                    ┌────────────────────────┐
                    │ Get/Create CDP Client  │
                    │  & FrameContextManager │
                    └───────────┬────────────┘
                                │
                    ┌───────────▼────────────┐
                    │ FrameContextManager    │
                    │  .ensureInitialized()  │
                    └───────────┬────────────┘
                                │
                ┌───────────────┼───────────────┐
                ▼               ▼               ▼
    ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
    │ Page.enable  │ │ DOM.enable   │ │Runtime.enable│
    └──────┬───────┘ └──────┬───────┘ └──────┬───────┘
           │                │                │
           ▼                ▼                ▼
    [Attach Event Listeners]
    ═══════════════════════════════════════════════════
    
    • Page.frameAttached         • Page.frameNavigated
    • Page.frameDetached          • Runtime.executionContextCreated
    • Runtime.executionContextDestroyed

    Data Structures Created:
    ═══════════════════════════════════════════════════
    [FrameGraph]                   [sessions Map]
    ├─ frames: Map<frameId, FrameRecord>
    ├─ frameIndexMap: Map<frameIndex, frameId>
    └─ Root frame registered       [frameExecutionContexts Map]
                                   ├─ frameId → contextId
                                   └─ Empty, waiting for events

                                 │
                                 ▼
                    ┌────────────────────────┐
                    │ Page.getFrameTree()    │
                    │  Enumerate existing    │
                    │  frames at start       │
                    └───────────┬────────────┘
                                │
                    ┌───────────▼────────────┐
                    │ For each frame found:  │
                    │ • upsertFrame()        │
                    │ • setFrameSession()    │
                    │ • populateFrameOwner() │ ← Calls DOM.getFrameOwner!
                    │ • Assign frameIndex    │
                    └────────────────────────┘

    AFTER INITIALIZATION - Data State by Frame Type:
    ═══════════════════════════════════════════════════════════════
    
    ℹ️  NOTE: Page.getFrameTree captures ALL frames that exist at load time
    (including same-origin iframes). Page.frameAttached events handle:
    - Dynamically created iframes (added after page load via JavaScript)
    - Race conditions (frames attaching during initialization)
    - Frame navigations (creating new execution contexts)
    
    MAIN FRAME (frameIndex 0):
    ──────────────────────────────
    [FrameGraph]
    { frameId: "ROOT_123",
      backendNodeId: undefined,        ← Main frame has no <iframe> element
      executionContextId: 5 }          ← ✅ Usually available immediately
    
    SAME-ORIGIN IFRAMES (e.g., frameIndex 1):
    ──────────────────────────────────────────
    [FrameGraph] 
    { frameId: "ABC123",               ← ✅ From Page.getFrameTree (recursive childFrames)
      backendNodeId: 99,               ← ✅ From DOM.getFrameOwner("ABC123")
      executionContextId: undefined }  ← ❌ May still be loading (async)
    
    OOPIF FRAMES (e.g., frameIndex 3):
    ───────────────────────────────────
    [FrameGraph]
    { frameId: "XYZ789",               ← ✅ Discovered via captureOOPIFs
      backendNodeId: 123,              ← ✅ From DOM.getFrameOwner("XYZ789")
      executionContextId: undefined,   ← ❌ May still be loading
      sessionId: "oopif-session-1" }   ← ✅ Separate CDP session

    NOW READY: Event listeners active, frame manager tracking frames
    NEXT: getA11yDOM() will call buildBackendIdMaps() to get DOM structure
```

---

### Phase 2: DOM Capture - Multi-Path Frame Discovery

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         getA11yDOM() Called                              │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │ buildBackendIdMaps()    │
                    │  DOM.getDocument({      │
                    │    depth: -1,           │
                    │    pierce: true         │
                    │  })                     │
                    └────────────┬────────────┘
                                 │
                                 ▼
        ═════════════════════════════════════════════════════════
        DFS TRAVERSAL - Different Frame Types Discovered
        ═════════════════════════════════════════════════════════
        
        ⚠️  IMPORTANT: frameIndex Assignment
        ────────────────────────────────────────────────────────
        frameIndex is assigned in DFS traversal order, starting from 1:
        
        let nextFrameIndex = frameIndex + 1;  // Start at 1
        
        When an <iframe> is discovered:
          const iframeFrameIndex = nextFrameIndex++;
          frameMap.set(iframeFrameIndex, IframeInfo)
        
        This means frameIndex reflects DOM document order,
        NOT the order of CDP events or frame attachment!
        
        ────────────────────────────────────────────────────────

MAIN FRAME (frameIndex=0)
═══════════════════════════════════════════════════════════════
┌─────────────────────────────────────────┐
│ <html>                                  │
│   <body>                                │
│     <button id="login">Login</button>   │  backendNodeId: 15
│     <iframe src="/same-origin.html">    │  backendNodeId: 99
│     <iframe src="https://ads.com">      │  backendNodeId: 123
│   </body>                               │
│ </html>                                 │
└─────────────────────────────────────────┘

Data Stored:
──────────────────────────────────────────
[tagNameMap]        [backendNodeMap]      [xpathMap]
"0-15" → "button"   "0-15" → 15           "0-15" → "//button[1]"
"0-99" → "iframe"   "0-99" → 99           "0-99" → "//iframe[1]"
"0-123" → "iframe"  "0-123" → 123         "0-123" → "//iframe[2]"


SAME-ORIGIN IFRAME (frameIndex=1)
═══════════════════════════════════════════════════════════════
┌─────────────────────────────────────────┐
│ contentDocument returned in             │
│ DOM.getDocument response                │
│                                         │
│ <html>                                  │
│   <body>                                │
│     <input type="email">                │  backendNodeId: 42
│     <input type="password">             │  backendNodeId: 43
│   </body>                               │
│ </html>                                 │
└─────────────────────────────────────────┘

Data Stored:
──────────────────────────────────────────
[frameMap]
1 → IframeInfo {
  frameIndex: 1,
  src: "/same-origin.html",
  xpath: "//iframe[1]",
  frameId: undefined,                   ← ❌ NOT in DOM.getDocument response!
  parentFrameIndex: 0,
  iframeBackendNodeId: 99,              ← ✅ This is available
  contentDocumentBackendNodeId: 100,    ← ✅ This is available
  executionContextId: undefined         ← ❌ Not yet available!
}

[backendNodeMap]        [xpathMap]
"1-42" → 42            "1-42" → "//input[1]"     ← Relative to iframe!
"1-43" → 43            "1-43" → "//input[2]"

⚠️ CRITICAL: frameId is undefined! Will be populated later via:
   ensureInitialized() → DOM.getFrameOwner(frameId from events) → backendNodeId 99
   Then syncFrameContextManager matches: backendNodeId 99 → frame 1


NESTED SAME-ORIGIN IFRAME (frameIndex=2)
═══════════════════════════════════════════════════════════════
If iframe #1 contains another iframe:

┌─────────────────────────────────────────┐
│ Parent: frameIndex=1                    │
│   <iframe src="/nested.html">           │  backendNodeId: 50
│     <html>                              │
│       <button>Nested Button</button>    │  backendNodeId: 67
│     </html>                             │
│   </iframe>                             │
└─────────────────────────────────────────┘

[frameMap]
2 → IframeInfo {
  frameIndex: 2,
  parentFrameIndex: 1,                  ← Parent is iframe #1
  frameId: "DEF456",
  xpath: "//iframe[1]",                 ← Relative to parent frame
  ...
}

[backendNodeMap]
"2-67" → 67


OOPIF (Cross-Origin) - frameIndex=3
═══════════════════════════════════════════════════════════════
┌─────────────────────────────────────────┐
│ ❌ contentDocument NOT in response      │
│    (security: cross-origin)             │
│                                         │
│ <iframe src="https://ads.com">          │
│   [content hidden by browser]           │
│ </iframe>                               │
└─────────────────────────────────────────┘

[frameMap]
3 → IframeInfo {
  frameIndex: 3,
  src: "https://ads.com",
  frameId: undefined,                   ← Not in DOM response!
  parentFrameIndex: 0,
  iframeBackendNodeId: 123,
  contentDocumentBackendNodeId: undefined,  ← Can't access
  executionContextId: undefined
}

⏳ WAIT: Need separate CDP session for OOPIF
          Will be discovered via captureOOPIFs()


After DOM Traversal Complete - Data State Summary:
═══════════════════════════════════════════════════════════════

MAIN FRAME (index 0):
──────────────────────────────────────────────────────────────
From buildBackendIdMaps:
  [backendNodeMap]  "0-15" → 15    ✅ All elements mapped
  [xpathMap]        "0-15" → "//button[1]"  ✅ All XPaths
  [tagNameMap]      "0-15" → "button"  ✅ All tags

From ensureInitialized (Phase 1):
  [FrameGraph]      { frameId: "ROOT", executionContextId: 5 }  ✅ Ready

Status: ✅ COMPLETE - Can interact with main frame immediately


SAME-ORIGIN IFRAME (index 1):
──────────────────────────────────────────────────────────────
From buildBackendIdMaps:
  [backendNodeMap]  "1-42" → 42, "1-43" → 43  ✅ All elements
  [xpathMap]        "1-42" → "//input[1]"  ✅ All XPaths
  [frameMap]        { iframeBackendNodeId: 99,
                      contentDocBackendNodeId: 100,
                      frameId: undefined }  ❌ Missing frameId!

From ensureInitialized (Phase 1):
  [FrameGraph]      { frameId: "ABC123",
                      backendNodeId: 99 }  ✅ Has frameId + backendNodeId

Status: ⚠️  NEEDS SYNC - frameMap missing frameId & executionContextId
        → syncFrameContextManager will match via backendNodeId 99


OOPIF IFRAME (index 3):
──────────────────────────────────────────────────────────────
From buildBackendIdMaps (main frame):
  [frameMap]        { iframeBackendNodeId: 123,
                      contentDocBackendNodeId: undefined }  
                    ❌ NO content (cross-origin blocked!)

From ensureInitialized (Phase 1):
  [FrameGraph]      { frameId: "XYZ789",
                      backendNodeId: 123,
                      sessionId: "oopif-sess" }  ✅ Has separate session

Status: ❌ INCOMPLETE - Need Phase 3 to get OOPIF content
        → captureOOPIFs will call buildBackendIdMaps(oopifSession)

────────────────────────────────────────────────────────────────
NEXT STEPS:
1. Phase 3: Fetch OOPIF content via their separate CDP sessions
2. Phase 4: syncFrameContextManager to populate missing frameIds
3. Phase 5: Fetch accessibility trees for all frames
```

---

### Phase 3: OOPIF Discovery & Session Creation

```
┌─────────────────────────────────────────────────────────────┐
│  captureOOPIFs() - For Cross-Origin Frames                 │
└────────────────────────┬────────────────────────────────────┘
                         │
        ┌────────────────┼────────────────┐
        ▼                ▼                ▼
[page.frames()]   Find frames not  Create dedicated
Playwright API    in frameMap      CDP session
        │                │                │
        └────────────────┼────────────────┘
                         │
                         ▼
            ┌───────────────────────┐
            │ For each OOPIF frame: │
            └───────────┬───────────┘
                        │
            ┌───────────▼───────────┐
            │ newCDPSession() for   │
            │ this specific frame   │
            └───────────┬───────────┘
                        │
            ┌───────────▼───────────┐
            │ DOM.enable on OOPIF   │
            │ session               │
            └───────────┬───────────┘
                        │
            ┌───────────▼───────────┐
            │ DOM.getDocument on    │
            │ OOPIF session         │
            └───────────┬───────────┘
                        │
                        ▼
        Build maps for OOPIF frame:
        ──────────────────────────────
        [backendNodeMap]
        "3-89" → 89     ← OOPIF content!
        
        [frameMap]
        3 → IframeInfo {
          frameIndex: 3,
          frameId: "GHI789",      ← Now available!
          sessionId: "oopif-sess-1",
          ...
        }

        [sessions Map]
        "GHI789" → CDPSession (OOPIF)

Data After OOPIF Discovery:
═══════════════════════════════════════════════════════════════
├─ [backendNodeMap]    ✅ Complete (all frames)
├─ [xpathMap]          ✅ Complete (all frames)
├─ [frameMap]          ⚠️  Still incomplete:
│                          • frameId: ✅ Now complete
│                          • executionContextId: ❌ Still missing!
└─ Need Phase 4 for execution contexts
```

---

### Phase 4: Execution Context Collection - Critical Synchronization

```
┌─────────────────────────────────────────────────────────────────┐
│            syncFrameContextManager() - Merge Two Views          │
│  (DOM-discovered frames ↔ Event-tracked frames)                │
└────────────────────────────┬────────────────────────────────────┘
                             │
                ┌────────────▼────────────┐
                │ For each IframeInfo in  │
                │ frameMap:               │
                └────────────┬────────────┘
                             │
        ┌────────────────────┼────────────────────┐
        ▼                    ▼                    ▼
Match by frameId      Match by               Match by
(if available)    backendNodeId           Playwright frame
        │                    │                    │
        └────────────────────┼────────────────────┘
                             │
                             ▼
            ┌────────────────────────────────────────────────────────┐
            │ MATCHING LOGIC - Concrete Example:                    │
            │                                                        │
            │ SAME-ORIGIN IFRAME (frameIndex 1):                    │
            │ ─────────────────────────────────────                 │
            │ frameMap[1]:                                           │
            │   { iframeBackendNodeId: 99,  ← Primary matching key! │
            │     frameId: undefined }                               │
            │                                                        │
            │ FrameContextManager.getFrameByBackendNodeId(99):      │
            │   { frameId: "ABC123", backendNodeId: 99 }  ← Match!  │
            │                                                        │
            │ TWO-WAY DATA COPY:                                     │
            │ ────────────────────                                  │
            │ FrameContextManager → frameMap[1]:                    │
            │   frameMap[1].frameId = "ABC123"  ✅                  │
            │   frameMap[1].executionContextId = 5  ✅              │
            │                                                        │
            │ frameMap[1] → FrameContextManager:                    │
            │   manager.assignFrameIndex("ABC123", 1)  ✅           │
            │   (Overwrites with DOM traversal order)               │
            └───────────────────────┬────────────────────────────────┘
                                    │
                                    ▼
    ⏳ WAIT FOR EXECUTION CONTEXTS
    ═══════════════════════════════════════════════════════════════
    
    Problem: Runtime.executionContextCreated events are async!
    
    Timeline for each frame:
    ────────────────────────────────────────────────────────────
    T=0ms    Page.frameAttached fires
             └─> FrameContextManager.upsertFrame()
                 [frameGraph] has frameId, but no contextId yet
    
    T=50ms   Page.frameNavigated fires
             └─> Frame is loading...
    
    T=120ms  Runtime.executionContextCreated fires  ← Finally!
             └─> frameExecutionContexts.set(frameId, contextId)
    
    T=200ms  syncFrameContextManager() runs
             └─> Copies contextId into IframeInfo
    
    ⏳ If contextId not ready yet, we wait:
    ═══════════════════════════════════════════════════════════════
    
    ┌──────────────────────────────────────┐
    │ frameManager                         │
    │  .waitForExecutionContext(frameId,   │
    │    timeoutMs: 750)                   │
    └───────────┬──────────────────────────┘
                │
        ┌───────┼───────┐
        ▼       │       ▼
    Already   Wait    Timeout
    available  for    after
              event   750ms
        │       │       │
        └───────┼───────┘
                │
                ▼
    Returns: contextId | undefined


Frame Type-Specific Context Handling:
═══════════════════════════════════════════════════════════════

Main Frame (index=0):
────────────────────────────────────────
Context usually available immediately
Events tracked on root session
✅ High success rate

Same-Origin Iframe (index=1):
────────────────────────────────────────
Shares root session with main frame
Context created after iframe loads
⚠️  May need short wait (~100ms)

Nested Same-Origin Iframe (index=2):
────────────────────────────────────────
Also on root session
Context created after parent + child load
⚠️  May need wait (~200ms)

OOPIF (index=3):
────────────────────────────────────────
Separate CDP session
Context on OOPIF session, not root
⚠️  Requires captureOOPIFs() first
⏳ May take longer to initialize


After Execution Context Collection:
═══════════════════════════════════════════════════════════════
[frameMap] - NOW COMPLETE!
1 → IframeInfo {
  frameIndex: 1,
  frameId: "ABC123",
  executionContextId: 5,        ✅ NOW AVAILABLE!
  sessionId: "root-session",
  iframeBackendNodeId: 99,
  ...
}

[frameExecutionContexts Map]
"ABC123" → 5
"DEF456" → 8
"GHI789" → 12

✅ Can now inject scripts and evaluate XPath in correct contexts!
```

---

### Phase 5: Accessibility Tree Fetch

```
┌─────────────────────────────────────────────────────────────────┐
│               fetchIframeAXTrees() - Get Semantics              │
└────────────────────────────┬────────────────────────────────────┘
                             │
        ┌────────────────────┼────────────────────┐
        ▼                    ▼                    ▼
    Main Frame        Same-Origin Frames      OOPIF Frames
        │                    │                    │
        ▼                    ▼                    ▼
Accessibility       Accessibility         Accessibility
.getFullAXTree()    .getPartialAXTree()   .getPartialAXTree()
                    (contentDocBackendId)  (on OOPIF session)
        │                    │                    │
        └────────────────────┼────────────────────┘
                             │
                             ▼
        ═══════════════════════════════════════════════
        Accessibility Nodes Collected Per Frame
        ═══════════════════════════════════════════════
        
        Frame 0 (main):
        ├─ { nodeId: "ax-1", role: "WebArea", childIds: [...] }
        ├─ { nodeId: "ax-2", role: "button", name: "Login",
        │    backendDOMNodeId: 15 }  ← LINKS TO DOM!
        └─ ...
        
        Frame 1 (same-origin iframe):
        ├─ { nodeId: "ax-10", role: "textbox", name: "Email",
        │    backendDOMNodeId: 42 }  ← LINKS TO DOM!
        └─ ...
        
        Frame 3 (OOPIF):
        ├─ { nodeId: "ax-20", role: "button", name: "Ad Click",
        │    backendDOMNodeId: 89 }  ← LINKS TO DOM!
        └─ ...

Key Connection:
═══════════════════════════════════════════════════════════════
backendDOMNodeId (from AX tree) === backendNodeId (from DOM tree)

This is how we merge semantic data with structural data!
```

---

### Phase 6: Build Hierarchical Tree - Merge All Data

```
┌─────────────────────────────────────────────────────────────────┐
│           buildHierarchicalTree() - Final Assembly              │
└────────────────────────────┬────────────────────────────────────┘
                             │
            ┌────────────────▼────────────────┐
            │ For each frame's AX nodes:      │
            └────────────────┬────────────────┘
                             │
            ┌────────────────▼────────────────┐
            │ For each AX node with           │
            │ backendDOMNodeId:               │
            └────────────────┬────────────────┘
                             │
                             ▼
        ═══════════════════════════════════════════════════════
        CREATE ENRICHED ELEMENT
        ═══════════════════════════════════════════════════════
        
        Input from different sources:
        ────────────────────────────────────────────────────
        [AX Node]                [DOM Maps]
        role: "button"          tagNameMap["1-42"] = "button"
        name: "Login"           xpathMap["1-42"] = "//button[1]"
        backendDOMNodeId: 42    backendNodeMap["1-42"] = 42
                                frameMap.get(1) = IframeInfo {...}
        
                             │
                             ▼
        ┌────────────────────────────────────┐
        │ encodedId = createEncodedId(       │
        │   frameIndex,                      │
        │   backendDOMNodeId                 │
        │ )                                  │
        │ // "1-42"                          │
        └────────────────┬───────────────────┘
                         │
                         ▼
        [AccessibilityNode with encodedId]
        {
          encodedId: "1-42",              ← Universal key!
          role: "button",
          name: "Login",
          backendDOMNodeId: 42,
          xpath: "//button[1]",           ← From xpathMap
          frameIndex: 1,                  ← Embedded in encodedId
          // Can now resolve to:
          // - CDP session (via frameMap)
          // - executionContextId (via frameMap)
          // - XPath (via xpathMap)
        }
        
                         │
                         ▼
        ┌────────────────────────────────────┐
        │ elements.set(encodedId, node)      │
        └────────────────────────────────────┘


Optional: Bounding Boxes (Visual Mode Only)
═══════════════════════════════════════════════════════════════

If mode === "visual-debug":

┌────────────────────────────────────────┐
│ batchCollectBoundingBoxes              │
│ Via CDP for each frame                 │
└───────────────┬────────────────────────┘
                │
    ⏳ REQUIRES: executionContextId per frame
                │
                ▼
    For each frame with executionContextId:
    ────────────────────────────────────────
    1. ensureScriptInjected(session, contextId)
       └─> Inject window.__hyperagent_collectBoundingBoxesByXPath
    
    2. Runtime.evaluate with contextId
       └─> Call injected function with XPath map
    
    3. Get coordinates for each element
    
    4. If iframe: translate coordinates
       └─> Add iframe.absoluteBoundingBox offset
    
                │
                ▼
    [boundingBoxMap]
    "0-15" → { x: 100, y: 200, width: 80, height: 40, ... }
    "1-42" → { x: 50, y: 500, width: 100, height: 35, ... }
             └─ Already translated to main viewport!
```

---

### Phase 7: Final State Assembly - Ready for LLM

```
┌─────────────────────────────────────────────────────────────────┐
│                    ALL DATA COLLECTED ✅                         │
└────────────────────────────┬────────────────────────────────────┘
                             │
            ┌────────────────▼────────────────┐
            │ Assemble A11yDOMState            │
            └────────────────┬────────────────┘
                             │
                             ▼
        ═══════════════════════════════════════════════════════
        COMPLETE DATA STRUCTURE
        ═══════════════════════════════════════════════════════
        
        A11yDOMState {
          
          // For LLM:
          ────────────────────────────────────────────────────
          simplified: string
            "[0-15] button 'Login'
             [0-23] textbox 'Email'
             
             Frame 1 (/same-origin.html):
             [1-42] button 'Submit'
             [1-43] textbox 'Password'
             
             Frame 3 (https://ads.com):
             [3-89] link 'Click Here'"
          
          elements: Map<EncodedId, AccessibilityNode>
            "0-15" → { role, name, encodedId, ... }
            "1-42" → { role, name, encodedId, ... }
            "3-89" → { role, name, encodedId, ... }
          
          screenshot?: Buffer              (if visual mode)
          overlayImage?: Buffer            (if visual mode)
          
          // For Element Resolution:
          ────────────────────────────────────────────────────
          backendNodeMap: Record<EncodedId, number>
            "0-15" → 15
            "1-42" → 42
            "3-89" → 89
          
          xpathMap: Record<EncodedId, string>
            "0-15" → "//button[1]"
            "1-42" → "//button[1]"           (relative to frame)
            "3-89" → "//a[1]"                (in OOPIF)
          
          frameMap: Map<number, IframeInfo>
            0 → { frameIndex: 0, frameId: "ROOT", ... }
            1 → { frameIndex: 1, frameId: "ABC123",
                  executionContextId: 5, ... }      ✅ COMPLETE
            3 → { frameIndex: 3, frameId: "GHI789",
                  executionContextId: 12,           ✅ COMPLETE
                  sessionId: "oopif-sess-1", ... }
          
          boundingBoxMap?: Map<EncodedId, DOMRect>
            "0-15" → { x: 100, y: 200, ... }
            "1-42" → { x: 50, y: 500, ... }    (translated!)
          
          // Metadata:
          ────────────────────────────────────────────────────
          domState: string     (raw tree)
          metrics: {
            totalElements: 156,
            frameCount: 3,
            captureTimeMs: 450
          }
        }
        
                             │
                             ▼
        ┌────────────────────────────────────┐
        │ Return to caller                   │
        │ (executeSingleAction or            │
        │  runAgentTask)                     │
        └────────────────┬───────────────────┘
                         │
                         ▼
        ┌────────────────────────────────────┐
        │ LLM Call with DOM State             │
        │                                    │
        │ LLM receives:                      │
        │ • simplified tree                  │
        │ • screenshot (if visual mode)      │
        │                                    │
        │ LLM returns:                       │
        │ { elementId: "1-42",               │
        │   method: "click",                 │
        │   arguments: [] }                  │
        └────────────────┬───────────────────┘
                         │
                         ▼
        ┌────────────────────────────────────┐
        │ resolveElement("1-42", {           │
        │   frameMap,                        │
        │   backendNodeMap,                  │
        │   xpathMap,                        │
        │   frameContextManager              │
        │ })                                 │
        │                                    │
        │ Uses ALL the data we collected! ✅  │
        └────────────────────────────────────┘
```

---

### Summary: Critical Synchronization Points

```
DATA COLLECTION STAGES:
═══════════════════════════════════════════════════════════════

Stage 1: Event Listeners
├─ FrameContextManager initialized
├─ Listening for Page/Runtime events
└─ Data: [FrameGraph] skeleton, [sessions], [frameExecutionContexts] empty

Stage 2: DOM Traversal
├─ buildBackendIdMaps() via DOM.getDocument
├─ Same-origin frames: ✅ Complete DOM data
├─ OOPIF frames: ⚠️  Only iframe element, no content
└─ Data: [backendNodeMap], [xpathMap], [frameMap] (partial)

⏳ SYNC POINT 1: OOPIF Discovery
├─ captureOOPIFs() for cross-origin frames
├─ Create dedicated CDP sessions
└─ Data: [frameMap] updated with OOPIF frameIds

Stage 3: Execution Context Wait
├─ syncFrameContextManager() merges views
├─ waitForExecutionContext() for each frame
└─ ⏳ CRITICAL: Block until contexts available

⏳ SYNC POINT 2: Execution Contexts Ready
├─ All frames have executionContextId
├─ Can now inject scripts
└─ Data: [frameMap] complete with contextIds

Stage 4: Accessibility Tree
├─ fetchIframeAXTrees() via Accessibility domain
└─ Data: AX nodes with backendDOMNodeId linkage

Stage 5: Merge & Enrich
├─ buildHierarchicalTree() creates encodedIds
├─ Optional: batchCollectBoundingBoxes()
└─ Data: [elements] Map, [boundingBoxMap]

Stage 6: Assembly
├─ Create final A11yDOMState
└─ ✅ READY FOR LLM


FRAME TYPE TIMINGS (Typical):
═══════════════════════════════════════════════════════════════

Main Frame:           ~50ms   (immediate)
Same-Origin Iframe:   ~150ms  (DOM + context wait)
Nested Same-Origin:   ~250ms  (parent + child loading)
OOPIF:                ~400ms  (session creation + DOM + context)

Total for complex page with 2 same-origin + 1 OOPIF:
~450-600ms before LLM call can be made


FINAL DATA STATE - BY FRAME TYPE:
═══════════════════════════════════════════════════════════════

MAIN FRAME (frameIndex 0):
──────────────────────────────────────────────────────────────
{
  // From buildBackendIdMaps:
  backendNodeMap: { "0-15": 15, "0-224": 224, ... },
  xpathMap: { "0-15": "//button[1]", ... },
  
  // From ensureInitialized + syncFrameContextManager:
  frameMap: Map {
    0 => {
      frameIndex: 0,
      frameId: "ROOT_123",
      executionContextId: 5,           ✅ Available immediately
      sessionId: "root-session",
      url: "https://example.com"
    }
  },
  
  // From buildHierarchicalTree:
  elements: Map {
    "0-15" => { 
      encodedId: "0-15",
      role: "button",
      name: "Login",
      backendDOMNodeId: 15,
      xpath: "//button[1]",
      frameIndex: 0
    }
  }
}

SAME-ORIGIN IFRAME (frameIndex 1):
──────────────────────────────────────────────────────────────
{
  // From buildBackendIdMaps (pierce: true captured content):
  backendNodeMap: { "1-42": 42, "1-43": 43, ... },
  xpathMap: { "1-42": "//input[1]", ... },  ← Relative to iframe
  
  // From ensureInitialized → DOM.getFrameOwner:
  // FrameGraph had: { frameId: "ABC123", backendNodeId: 99 }
  
  // From syncFrameContextManager (matched by backendNodeId 99):
  frameMap: Map {
    1 => {
      frameIndex: 1,
      frameId: "ABC123",               ← Matched via backendNodeId!
      executionContextId: 5,           ← ✅ From events
      sessionId: "root-session",       ← Shares main session
      parentFrameIndex: 0,
      iframeBackendNodeId: 99,
      contentDocBackendNodeId: 100,
      src: "/child.html",
      absoluteBoundingBox: { ... }
    }
  },
  
  // From buildHierarchicalTree:
  elements: Map {
    "1-42" => {
      encodedId: "1-42",
      role: "textbox",
      name: "Email",
      backendDOMNodeId: 42,
      xpath: "//input[1]",             ← Relative to frame 1
      frameIndex: 1
    }
  }
}

OOPIF / CROSS-ORIGIN IFRAME (frameIndex 3):
──────────────────────────────────────────────────────────────
{
  // From buildBackendIdMaps (main frame):
  // ❌ OOPIF content NOT captured (cross-origin blocked)
  
  // From captureOOPIFs → buildBackendIdMaps(oopifSession, pierce: false):
  backendNodeMap: { "3-89": 89, "3-90": 90, ... },
  xpathMap: { "3-89": "//a[1]", ... },  ← From OOPIF session
  
  // From ensureInitialized → captureOOPIFs:
  // Created separate CDP session via context.newCDPSession()
  // FrameGraph had: { frameId: "XYZ789", backendNodeId: 123, sessionId: "oopif-1" }
  
  // From syncFrameContextManager:
  frameMap: Map {
    3 => {
      frameIndex: 3,
      frameId: "XYZ789",               ← From captureOOPIFs
      executionContextId: 12,          ← ✅ From OOPIF session events
      sessionId: "oopif-session-1",    ← ✅ Separate session!
      parentFrameIndex: 0,
      iframeBackendNodeId: 123,        ← From main frame DOM
      contentDocBackendNodeId: undefined,  ← Not accessible from main
      src: "https://ads.com/banner",
      absoluteBoundingBox: { ... }
    }
  },
  
  // From buildHierarchicalTree:
  elements: Map {
    "3-89" => {
      encodedId: "3-89",
      role: "link",
      name: "Click Ad",
      backendDOMNodeId: 89,            ← From OOPIF's DOM
      xpath: "//a[1]",                 ← Relative to frame 3
      frameIndex: 3
    }
  }
}

KEY DIFFERENCES:
──────────────────────────────────────────────────────────────
• Main Frame: executionContextId immediate, no parent
• Same-Origin: Matched via backendNodeId, shares root session
• OOPIF: Separate session, discovered via Target events, pierce:false


WHY WE NEED ALL THIS DATA:
═══════════════════════════════════════════════════════════════

LLM returns: "1-42"

To act on it, we need:
├─ backendNodeMap["1-42"] → 42           (which DOM node)
├─ xpathMap["1-42"] → "//button[1]"      (fallback if stale)
├─ frameMap.get(1) → IframeInfo {        (which frame)
│    frameId: "ABC123",                  (for session lookup)
│    executionContextId: 5,              (for XPath evaluation)
│    sessionId: "root" or "oopif-..."    (which CDP connection)
│  }
└─ frameContextManager.getFrameSession("ABC123") → CDPSession

Without ANY of these pieces, element resolution fails! 🚫
```

This flow diagram shows why the synchronization is so complex and why we need multiple maps and event listeners working together.

