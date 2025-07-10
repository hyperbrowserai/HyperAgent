import {
  INTERACTIVE_ELEMENTS,
  INTERACTIVE_ROLES,
  INTERACTIVE_ARIA_PROPS,
  CLICK_ATTRIBUTES,
} from "./const";

export const isInteractiveElem = (
  element: HTMLElement,
): { isInteractive: boolean; reason: string } => {
  const tagName = element.tagName.toLowerCase();
  const role = element.getAttribute("role");
  const ariaRole = element.getAttribute("aria-role");

  const hasInteractiveRole =
    INTERACTIVE_ELEMENTS.has(tagName) ||
    INTERACTIVE_ROLES.has(role || "") ||
    INTERACTIVE_ROLES.has(ariaRole || "");

  if (hasInteractiveRole) {
    let reason = "";
    if (INTERACTIVE_ELEMENTS.has(tagName)) {
      reason = `Interactive HTML element: <${tagName}>`;
    } else if (INTERACTIVE_ROLES.has(role || "")) {
      reason = `Interactive role: ${role}`;
    } else if (INTERACTIVE_ROLES.has(ariaRole || "")) {
      reason = `Interactive aria-role: ${ariaRole}`;
    }
    return { isInteractive: true, reason };
  }

  const hasClickHandler =
    element.onclick !== null ||
    element.getAttribute("onclick") !== null ||
    CLICK_ATTRIBUTES.some((attr) => element.hasAttribute(attr));

  if (hasClickHandler) {
    return { isInteractive: true, reason: "Has click handler" };
  }

  // Check for the marker attribute set by the injected script
  const hasInjectedListener = element.hasAttribute(
    "data-has-interactive-listener",
  );

  if (hasInjectedListener) {
    return {
      isInteractive: true,
      reason: "Has interactive event listener (tracked)",
    };
  }

  const hasAriaProps = INTERACTIVE_ARIA_PROPS.some((prop) =>
    element.hasAttribute(prop),
  );

  if (hasAriaProps) {
    const props = INTERACTIVE_ARIA_PROPS.filter((prop) =>
      element.hasAttribute(prop),
    );
    return {
      isInteractive: true,
      reason: `Has interactive ARIA properties: ${props.join(", ")}`,
    };
  }

  const isContentEditable =
    element.getAttribute("contenteditable") === "true" ||
    element.isContentEditable;

  if (isContentEditable) {
    return { isInteractive: true, reason: "Is content editable" };
  }

  const isDraggable =
    element.draggable || element.getAttribute("draggable") === "true";

  if (isDraggable) {
    return { isInteractive: true, reason: "Is draggable" };
  }

  return { isInteractive: false, reason: "Not interactive" };
};

export const isIgnoredElem = (element: HTMLElement): boolean => {
  const rect = element.getBoundingClientRect();
  const isNotVisible = rect.width === 0 || rect.height === 0;

  return (
    element.tagName.toLowerCase() === "html" ||
    element.tagName.toLowerCase() === "body" ||
    isNotVisible ||
    element.hasAttribute("disabled") ||
    element.getAttribute("aria-disabled") === "true"
  );
};
