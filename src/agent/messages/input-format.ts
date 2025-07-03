export const INPUT_FORMAT_FIND_ELEMENT = `=== Final Goal ===
[The final goal that needs to be accomplished]
=== Current URL ===
[The current URL]
=== Elements ===
[A list of the elements on the page in the following format]
[index]<type attributes...>value</type>
- type: HTML element type (button, input, etc.)
- index: Numeric identifier for interaction 
- attributes: All HTML attributes of the element like type, name, value, class, etc. This can include:
  * Data attributes
  * ARIA attributes 
  * Custom attributes
  * Any other valid HTML attributes
  * The attributes provide important context about the element's behavior, accessibility, and styling
=== Page Screenshot ===
- A screenshot of the current page with the interactive elements highlighted with their index
=== Page State ===
- Pixels below
- Pixels above`;

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
[index]<type attributes...>value</type>
- type: HTML element type (button, input, etc.)
- index: Numeric identifier for interaction 
- attributes: All HTML attributes of the element like type, name, value, class, etc. This can include:
  * Data attributes
  * ARIA attributes 
  * Custom attributes
  * Any other valid HTML attributes
  * The attributes provide important context about the element's behavior, accessibility, and styling
=== Previous Actions ===
[The previous steps of the task]
=== Page Screenshot ===
- A screenshot of the current page with the interactive elements highlighted with their index
=== Page State ===
- Pixels below
- Pixels above`;
