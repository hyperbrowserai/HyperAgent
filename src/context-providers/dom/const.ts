export const INTERACTIVE_ELEMENTS = new Set([
  "a",
  "input",
  "button",
  "select",
  "menu",
  "menuitem",
  "textarea",
  "canvas",
  "embed",
]);

export const INTERACTIVE_ROLES = new Set([
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
  "action",
]);

export const INTERACTIVE_EVENTS = new Set([
  "click",
  "mousedown",
  "mouseup",
  "touchstart",
  "touchend",
]);

export const INTERACTIVE_ARIA_PROPS = [
  "aria-expanded",
  "aria-pressed",
  "aria-selected",
  "aria-checked",
];

export const CLICK_ATTRIBUTES = ["onclick", "ng-click", "@click", "v-on:click"];

export const CONTEXT_ATTRIBUTES = [
  "title",
  "type",
  "name",
  "role",
  "aria-label",
  "placeholder",
  "value",
  "alt",
  "aria-expanded",
];
