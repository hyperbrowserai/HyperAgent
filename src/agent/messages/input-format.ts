export const INPUT_FORMAT = `=== Final Goal ===
[The final goal that needs to be accomplished]
=== Open Tabs ===
[The open tabs]
=== Current URL ===
[The current URL]
=== Variables ===
[Variables that can be used in the task]
- Variables are referenced using <<name>> syntax
- Each variable has a name and description
- Variables persist across actions and can be referenced in subsequent steps
- Format: <<name>> - {description}
=== Elements ===
[A list of the elements on the page in the following format]
[encodedId] type: name attributes
- type: HTML element type (button, input, etc.)
- encodedId: Element identifier in format "frameIndex-nodeId" (e.g., "0-1234")
- name: The accessible name or label of the element
- attributes: All HTML attributes of the element like type, name, value, class, etc. This can include:
  * Data attributes
  * ARIA attributes
  * Custom attributes
  * Any other valid HTML attributes
  * The attributes provide important context about the element's behavior, accessibility, and styling
- When choosing an element for \`actElement\`, reference the exact \`encodedId\` shown here (for example, \`"0-5125"\`).
=== Previous Actions ===
[The previous steps of the task]
=== Page Screenshot === (only in visual modes)
- A screenshot of the current page
- In visual-debug mode, interactive elements are highlighted with their encodedId
=== Page State === (only in visual modes)
- Pixels below: Number of pixels scrolled below current viewport
- Pixels above: Number of pixels scrolled above current viewport`;
