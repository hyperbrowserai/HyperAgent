export const buildDomViewJs = `(() => {
  // src/context-providers/dom/const.ts
  var INTERACTIVE_ELEMENTS = /* @__PURE__ */ new Set([
    "a",
    "input",
    "button",
    "select",
    "menu",
    "menuitem",
    "textarea",
    "canvas",
    "embed"
  ]);
  var INTERACTIVE_ROLES = /* @__PURE__ */ new Set([
    "button",
    "link",
    "checkbox",
    "radio",
    "textbox",
    "menuitem",
    "tab",
    "tabpanel",
    "tooltip",
    "slider",
    "progressbar",
    "switch",
    "listbox",
    "option",
    "combobox",
    "menu",
    "treeitem",
    "tree",
    "spinbutton",
    "scrollbar",
    "menuitemcheckbox",
    "menuitemradio",
    "action"
  ]);
  var INTERACTIVE_ARIA_PROPS = [
    "aria-expanded",
    "aria-pressed",
    "aria-selected",
    "aria-checked"
  ];
  var CLICK_ATTRIBUTES = ["onclick", "ng-click", "@click", "v-on:click"];
  var CONTEXT_ATTRIBUTES = [
    "title",
    "type",
    "name",
    "role",
    "aria-label",
    "placeholder",
    "value",
    "alt",
    "aria-expanded"
  ];

  // src/context-providers/dom/elem-interactive.ts
  var isInteractiveElem = (element) => {
    const tagName = element.tagName.toLowerCase();
    const role = element.getAttribute("role");
    const ariaRole = element.getAttribute("aria-role");
    const hasInteractiveRole = INTERACTIVE_ELEMENTS.has(tagName) || INTERACTIVE_ROLES.has(role || "") || INTERACTIVE_ROLES.has(ariaRole || "");
    if (hasInteractiveRole) {
      let reason = "";
      if (INTERACTIVE_ELEMENTS.has(tagName)) {
        reason = \`Interactive HTML element: <\${tagName}>\`;
      } else if (INTERACTIVE_ROLES.has(role || "")) {
        reason = \`Interactive role: \${role}\`;
      } else if (INTERACTIVE_ROLES.has(ariaRole || "")) {
        reason = \`Interactive aria-role: \${ariaRole}\`;
      }
      return { isInteractive: true, reason };
    }
    const hasClickHandler = element.onclick !== null || element.getAttribute("onclick") !== null || CLICK_ATTRIBUTES.some((attr) => element.hasAttribute(attr));
    if (hasClickHandler) {
      return { isInteractive: true, reason: "Has click handler" };
    }
    const hasInjectedListener = element.hasAttribute("data-has-interactive-listener");
    if (hasInjectedListener) {
      return { isInteractive: true, reason: "Has interactive event listener (tracked)" };
    }
    const hasAriaProps = INTERACTIVE_ARIA_PROPS.some(
      (prop) => element.hasAttribute(prop)
    );
    if (hasAriaProps) {
      const props = INTERACTIVE_ARIA_PROPS.filter(
        (prop) => element.hasAttribute(prop)
      );
      return {
        isInteractive: true,
        reason: \`Has interactive ARIA properties: \${props.join(", ")}\`
      };
    }
    const isContentEditable = element.getAttribute("contenteditable") === "true" || element.isContentEditable;
    if (isContentEditable) {
      return { isInteractive: true, reason: "Is content editable" };
    }
    const isDraggable = element.draggable || element.getAttribute("draggable") === "true";
    if (isDraggable) {
      return { isInteractive: true, reason: "Is draggable" };
    }
    return { isInteractive: false, reason: "Not interactive" };
  };
  var isIgnoredElem = (element) => {
    const rect = element.getBoundingClientRect();
    const isNotVisible = rect.width === 0 || rect.height === 0;
    return element.tagName.toLowerCase() === "html" || element.tagName.toLowerCase() === "body" || isNotVisible || element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true";
  };

  // src/context-providers/dom/find-interactive-elements.ts
  var findInteractiveElements = () => {
    const interactiveElements = [];
    const processedElements = /* @__PURE__ */ new Set();
    const processRoot = (root, rootInfo = {}) => {
      const elements = root.querySelectorAll("*");
      for (let i = 0; i < elements.length; i++) {
        const element = elements[i];
        if (processedElements.has(element)) {
          continue;
        }
        processedElements.add(element);
        if (element.shadowRoot) {
          processRoot(element.shadowRoot, {
            iframe: rootInfo.iframe,
            shadowHost: element
          });
        }
        const { isInteractive, reason } = isInteractiveElem(element);
        if (isIgnoredElem(element) || !isInteractive) {
          continue;
        }
        interactiveElements.push({
          element,
          iframe: rootInfo.iframe,
          shadowHost: rootInfo.shadowHost,
          rect: element.getBoundingClientRect(),
          interactiveReason: reason,
          isUnderShadowRoot: element.getRootNode().nodeType === Node.DOCUMENT_FRAGMENT_NODE,
          cssPath: "",
          xpath: ""
        });
      }
    };
    processRoot(document);
    const iframes = document.querySelectorAll("iframe");
    for (let i = 0; i < iframes.length; i++) {
      const iframe = iframes[i];
      try {
        const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
        if (iframeDoc) {
          processRoot(iframeDoc, { iframe });
        }
      } catch (e) {
        console.warn("error processing iframe", e);
      }
    }
    return interactiveElements;
  };

  // src/context-providers/dom/highlight.ts
  var isElementPartiallyVisible = (rect) => {
    return rect.width > 0 && rect.height > 0 && rect.top < window.innerHeight && // These checks are relative to the current viewport
    rect.bottom > 0 && // where the rect was calculated.
    rect.left < window.innerWidth && rect.right > 0;
  };
  var getHighlightColor = (index) => {
    const colors = [
      "#FF0000",
      "#00FF00",
      "#0000FF",
      "#FFA500",
      "#800080",
      "#008080",
      "#FF69B4",
      "#4B0082",
      "#FF4500",
      "#2E8B57",
      "#DC143C",
      "#4682B4"
    ];
    const colorIndex = index % colors.length;
    const baseColor = colors[colorIndex];
    const backgroundColor = baseColor + "1A";
    return { baseColor, backgroundColor };
  };
  var calculateLabelPosition = (rect, iframeOffset, labelWidth, labelHeight, canvasWidth, canvasHeight) => {
    const top = rect.top + iframeOffset.y;
    const left = rect.left + iframeOffset.x;
    let labelTop = top - labelHeight;
    let labelLeft = left + rect.width - labelWidth;
    labelTop = Math.min(labelTop, canvasHeight - labelHeight);
    labelLeft = Math.min(labelLeft, canvasWidth - labelWidth);
    const elementBottom = top + rect.height;
    const elementRight = left + rect.width;
    if (labelTop + labelHeight > top && labelTop < elementBottom && labelLeft + labelWidth > left && labelLeft < elementRight) {
      labelTop = elementBottom;
      labelLeft = elementRight - labelWidth;
      labelTop = Math.min(labelTop, canvasHeight - labelHeight);
      labelLeft = Math.min(labelLeft, canvasWidth - labelWidth);
    }
    return { top: labelTop, left: labelLeft };
  };
  function renderHighlightsOffscreen(highlightInfos, width, height) {
    if (width <= 0 || height <= 0) {
      console.warn(
        "Attempted to render highlights on zero-sized canvas. Will default to innerWidth x innerHeight"
      );
      const emptyCanvas = new OffscreenCanvas(
        window.innerWidth,
        window.innerHeight
      );
      return emptyCanvas.transferToImageBitmap();
    }
    const dpr = window.devicePixelRatio || 1;
    const canvasWidth = width * dpr;
    const canvasHeight = height * dpr;
    const offscreenCanvas = new OffscreenCanvas(canvasWidth, canvasHeight);
    const ctx = offscreenCanvas.getContext("2d", {
      alpha: true
    });
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);
    try {
      highlightInfos.forEach(({ element, index, parentIframe }) => {
        if (!document.body.contains(element)) {
          return;
        }
        const rect = element.getBoundingClientRect();
        if (!rect || rect.width === 0 || rect.height === 0 || !isElementPartiallyVisible(rect)) {
          return;
        }
        const iframeOffset = { x: 0, y: 0 };
        if (parentIframe && document.body.contains(parentIframe)) {
          const iframeRect = parentIframe.getBoundingClientRect();
          iframeOffset.x = iframeRect.left;
          iframeOffset.y = iframeRect.top;
        }
        const colors = getHighlightColor(index);
        const drawTop = rect.top + iframeOffset.y;
        const drawLeft = rect.left + iframeOffset.x;
        ctx.fillStyle = colors.backgroundColor;
        ctx.fillRect(drawLeft, drawTop, rect.width, rect.height);
        ctx.strokeStyle = colors.baseColor;
        ctx.lineWidth = 1;
        ctx.strokeRect(drawLeft, drawTop, rect.width, rect.height);
        const labelText = index.toString();
        const fontSize = Math.min(12, Math.max(9, rect.height * 0.3));
        ctx.font = \`bold \${fontSize}px sans-serif\`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const textMetrics = ctx.measureText(labelText);
        const labelPadding = 4;
        const labelHeight = fontSize + labelPadding;
        const labelWidth = Math.max(
          labelHeight,
          textMetrics.width + labelPadding * 2
        );
        const labelPos = calculateLabelPosition(
          rect,
          iframeOffset,
          labelWidth,
          labelHeight,
          width,
          height
        );
        ctx.fillStyle = colors.baseColor;
        ctx.fillRect(labelPos.left, labelPos.top, labelWidth, labelHeight);
        ctx.fillStyle = "white";
        ctx.fillText(
          labelText,
          labelPos.left + labelWidth / 2,
          labelPos.top + labelHeight / 2
        );
      });
      return offscreenCanvas.transferToImageBitmap();
    } catch (error) {
      console.error("Error drawing highlights onto OffscreenCanvas:", error);
      const emptyCanvas = new OffscreenCanvas(1, 1);
      return emptyCanvas.transferToImageBitmap();
    }
  }

  // src/context-providers/dom/get-css-path.ts
  var escapeSelector = (value) => {
    return CSS.escape(value);
  };
  var getUniqueSegment = (element) => {
    const tagName = element.tagName.toLowerCase();
    const parent = element.parentElement;
    if (element.id) {
      const idSelector = \`#\${escapeSelector(element.id)}\`;
      return idSelector;
    }
    const classes = Array.from(element.classList).map(escapeSelector).join(".");
    if (classes && parent) {
      const classSelector = \`\${tagName}.\${classes}\`;
      const siblingsWithSameClasses = Array.from(
        parent.querySelectorAll(\`:scope > \${classSelector}\`)
      );
      if (siblingsWithSameClasses.length === 1 && siblingsWithSameClasses[0] === element) {
        return classSelector;
      }
    }
    let index = 1;
    let sibling = element.previousElementSibling;
    while (sibling) {
      if (sibling.tagName === element.tagName) {
        index++;
      }
      sibling = sibling.previousElementSibling;
    }
    let hasSameTypeSiblings = index > 1;
    if (!hasSameTypeSiblings && parent) {
      sibling = element.nextElementSibling;
      while (sibling) {
        if (sibling.tagName === element.tagName) {
          hasSameTypeSiblings = true;
          break;
        }
        sibling = sibling.nextElementSibling;
      }
    }
    return hasSameTypeSiblings ? \`\${tagName}:nth-of-type(\${index})\` : tagName;
  };
  var getRelativeCSSPath = (element, boundary) => {
    if (element === boundary) {
      return "";
    }
    const segments = [];
    let currentElement = element;
    while (currentElement && currentElement !== boundary && currentElement.nodeType === Node.ELEMENT_NODE) {
      const segment = getUniqueSegment(currentElement);
      segments.unshift(segment);
      const parent = currentElement.parentElement;
      if (!parent || parent === boundary || parent.nodeType !== Node.ELEMENT_NODE) {
        break;
      }
      currentElement = parent;
    }
    return segments.join(" > ");
  };
  var getCSSPath = (element) => {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) {
      return "";
    }
    if (!element.isConnected) {
    }
    const root = element.getRootNode();
    if (root instanceof ShadowRoot) {
      const host = root.host;
      if (!host) {
        console.warn("ShadowRoot found without a host element:", root);
        return "";
      }
      const hostPath = getCSSPath(host);
      const relativePath = getRelativeCSSPath(element, root);
      if (!hostPath) {
        console.warn("Could not determine CSS path for host element:", host);
        return "";
      }
      if (!relativePath) {
        console.warn(
          "Could not determine relative CSS path within ShadowRoot for:",
          element
        );
        return "";
      }
      return \`\${hostPath} >> \${relativePath}\`;
    } else if (root instanceof Document) {
      return getRelativeCSSPath(element, root);
    } else {
      console.warn(
        "Element root is neither Document nor ShadowRoot:",
        root,
        "for element:",
        element
      );
      return getRelativeCSSPath(element, root);
    }
  };

  // src/context-providers/dom/get-x-path.ts
  var getXPath = (element) => {
    const segments = [];
    let currentElement = element;
    while (currentElement && currentElement.nodeType === Node.ELEMENT_NODE) {
      if (currentElement.parentNode instanceof ShadowRoot || currentElement.parentNode instanceof HTMLIFrameElement) {
        break;
      }
      let index = 0;
      let hasSiblings = false;
      let sibling = currentElement.previousSibling;
      while (sibling) {
        if (sibling.nodeType === Node.ELEMENT_NODE && sibling.nodeName === currentElement.nodeName) {
          index++;
          hasSiblings = true;
        }
        sibling = sibling.previousSibling;
      }
      if (!hasSiblings) {
        sibling = currentElement.nextSibling;
        while (sibling) {
          if (sibling.nodeType === Node.ELEMENT_NODE && sibling.nodeName === currentElement.nodeName) {
            hasSiblings = true;
            break;
          }
          sibling = sibling.nextSibling;
        }
      }
      const tagName = currentElement.nodeName.toLowerCase();
      const xpathIndex = hasSiblings ? \`[\${index + 1}]\` : "";
      if (currentElement.id && currentElement.id.toString().trim() !== "") {
        segments.unshift(\`\${tagName}[@id="\${currentElement.id}"]\`);
      } else {
        segments.unshift(\`\${tagName}\${xpathIndex}\`);
      }
      currentElement = currentElement.parentElement;
    }
    return segments.join("/");
  };

  // src/context-providers/dom/build-dom-view.ts
  var imageBitmapToPngDataUrl = (bitmap) => {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0);
      return canvas.toDataURL("image/png");
    } finally {
      bitmap.close();
    }
  };
  var getElementTextContent = (el) => {
    const tagName = el.tagName.toLowerCase();
    if (tagName === "input") {
      const inputElement = el;
      let labelText = null;
      if (inputElement.id) {
        const label = document.querySelector(\`label[for="\${inputElement.id}"]\`);
        if (label) {
          labelText = label.textContent?.trim() || null;
        }
      }
      return labelText ?? inputElement.value?.trim() ?? "";
    } else {
      return el.textContent?.trim() || "";
    }
  };
  var buildDomView = () => {
    const interactiveElements = findInteractiveElements();
    const screenBitmap = renderHighlightsOffscreen(
      interactiveElements.map((element, index) => ({
        element: element.element,
        index: index + 1,
        // index range from 1 -> index
        parentIframe: element.iframe ?? null
      })),
      window.innerWidth,
      window.innerHeight
    );
    const screenshotPngDataUrl = imageBitmapToPngDataUrl(screenBitmap);
    for (let idx = 0; idx < interactiveElements.length; idx++) {
      const element = interactiveElements[idx];
      element.highlightIndex = idx + 1;
      element.cssPath = getCSSPath(element.element);
      element.xpath = getXPath(element.element);
    }
    const domRepresentation = [];
    const getTextBetween = (node, nextNode) => {
      const texts = [];
      let current = node.nextSibling;
      while (current && current !== nextNode) {
        if (current.nodeType === Node.TEXT_NODE && current.textContent) {
          const text = current.textContent.trim();
          if (text) texts.push(text);
        }
        current = current.nextSibling;
      }
      return texts.join(" ");
    };
    for (let i = 0; i < interactiveElements.length; i++) {
      const element = interactiveElements[i];
      const el = element.element;
      const tagName = el.tagName.toLowerCase();
      let attributes = "";
      Array.from(el.attributes).forEach((attr) => {
        if (CONTEXT_ATTRIBUTES.includes(attr.name)) {
          attributes += \` \${attr.name}="\${attr.value}"\`;
        }
      });
      const textContent = getElementTextContent(el);
      const indexPrefix = \`[\${element.highlightIndex}]\`;
      const truncatedText = textContent.length > 1e3 ? textContent.substring(0, 997) + "..." : textContent;
      const elementString = \`\${indexPrefix}<\${tagName}\${attributes}>\${truncatedText.replace(/\\s+/g, " ")}</\${tagName}>\`;
      domRepresentation.push(elementString);
      const nextElement = interactiveElements[i + 1]?.element || null;
      const betweenText = getTextBetween(el, nextElement);
      if (betweenText) {
        domRepresentation.push(betweenText);
      }
    }
    return {
      elements: interactiveElements,
      domState: domRepresentation.join("\\n"),
      screenshot: screenshotPngDataUrl
    };
  };
  return buildDomView();
})();`;