import { z } from "zod";
import { ActionContext, AgentActionDefinition } from "@/types";

/**
 * Translates xdotool-like key strings to Playwright-compatible keys.
 * Reference: https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/key/Key_Values
 */
function translateKey(key: string): string {
  const keyMap: Record<string, string> = {
    // Common / Basic Keys
    return: "Enter",
    enter: "Enter",
    tab: "Tab",
    backspace: "Backspace",
    up: "ArrowUp",
    down: "ArrowDown",
    left: "ArrowLeft",
    right: "ArrowRight",
    space: "Space",
    ctrl: "Control",
    control: "Control",
    alt: "Alt",
    shift: "Shift",
    meta: "Meta",
    command: "Meta",
    cmd: "Meta",
    windows: "Meta",
    esc: "Escape",
    escape: "Escape",
    // Numpad Keys
    kp_0: "Numpad0",
    kp_1: "Numpad1",
    kp_2: "Numpad2",
    kp_3: "Numpad3",
    kp_4: "Numpad4",
    kp_5: "Numpad5",
    kp_6: "Numpad6",
    kp_7: "Numpad7",
    kp_8: "Numpad8",
    kp_9: "Numpad9",
    // Numpad Operations
    kp_enter: "NumpadEnter",
    kp_multiply: "NumpadMultiply",
    kp_add: "NumpadAdd",
    kp_subtract: "NumpadSubtract",
    kp_decimal: "NumpadDecimal",
    kp_divide: "NumpadDivide",
    // Navigation
    page_down: "PageDown",
    page_up: "PageUp",
    home: "Home",
    end: "End",
    insert: "Insert",
    delete: "Delete",
    // Function Keys
    f1: "F1",
    f2: "F2",
    f3: "F3",
    f4: "F4",
    f5: "F5",
    f6: "F6",
    f7: "F7",
    f8: "F8",
    f9: "F9",
    f10: "F10",
    f11: "F11",
    f12: "F12",
    // Left/Right Variants
    shift_l: "ShiftLeft",
    shift_r: "ShiftRight",
    control_l: "ControlLeft",
    control_r: "ControlRight",
    alt_l: "AltLeft",
    alt_r: "AltRight",
    // Media Keys
    audiovolumemute: "AudioVolumeMute",
    audiovolumedown: "AudioVolumeDown",
    audiovolumeup: "AudioVolumeUp",
    // Additional Special Keys
    print: "PrintScreen",
    scroll_lock: "ScrollLock",
    pause: "Pause",
    menu: "ContextMenu",
  };

  return keyMap[key.toLowerCase()] || key;
}

export const KeyPressAction = z
  .object({
    text: z.string().describe(
      `Press a key or key-combination on the keyboard.\n
- This supports xdotool's \`key\` syntax.\n
- Examples: "a", "Return", "alt+Tab", "ctrl+s", "Up", "KP_0" (for the numpad 0 key).
`,
    ),
  })
  .describe("Press a key or key-combination on the keyboard");

export type KeyPressActionType = z.infer<typeof KeyPressAction>;

export const KeyPressActionDefinition: AgentActionDefinition = {
  type: "keyPress" as const,
  actionParams: KeyPressAction,

  run: async (ctx: ActionContext, action: KeyPressActionType) => {
    const { text } = action;

    if (text.includes(" ") && !text.includes("+")) {
      const keys = text.split(" ");
      for (const k of keys) {
        await ctx.page.keyboard.press(translateKey(k));
      }
    } else if (text.includes("+")) {
      const keys = text.split("+");
      for (let i = 0; i < keys.length - 1; i++) {
        await ctx.page.keyboard.down(translateKey(keys[i]));
      }
      await ctx.page.keyboard.press(translateKey(keys[keys.length - 1]));
      for (let i = keys.length - 2; i >= 0; i--) {
        await ctx.page.keyboard.up(translateKey(keys[i]));
      }
    } else {
      await ctx.page.keyboard.press(translateKey(text));
    }

    return {
      success: true,
      message: `Pressed key "${text}"`,
    };
  },

  generateCode: async (ctx: ActionContext, action: KeyPressActionType) => {
    const { text } = action;

    if (text.includes(" ") && !text.includes("+")) {
      const keys = text.split(" ");
      let code = "";
      for (const k of keys) {
        const translatedKey = translateKey(k);
        code += `
        await ctx.page.keyboard.press(${JSON.stringify(translatedKey)});
        console.log(\`Pressed key: \${${JSON.stringify(translatedKey)}}\`);
        \n`;
      }
      return code;
    } else if (text.includes("+")) {
      let code = "";

      const keys = text.split("+");
      for (let i = 0; i < keys.length - 1; i++) {
        const translatedKey = translateKey(keys[i]);
        code += `
        await ctx.page.keyboard.down(${JSON.stringify(translatedKey)});
        console.log(\`Pressed key down: \${${JSON.stringify(translatedKey)}}\`);
        \n`;
      }

      const lastKey = translateKey(keys[keys.length - 1]);
      code += `
      await ctx.page.keyboard.press(${JSON.stringify(lastKey)});
      console.log(\`Pressed key: \${${JSON.stringify(lastKey)}}\`);
      \n`;

      for (let i = keys.length - 2; i >= 0; i--) {
        const translatedKey = translateKey(keys[i]);
        code += `
        await ctx.page.keyboard.up(${JSON.stringify(translatedKey)});
        console.log(\`Pressed key up: \${${JSON.stringify(translatedKey)}}\`);
        \n`;
      }

      return code;
    } else {
      const translatedKey = translateKey(text);
      return `
      await ctx.page.keyboard.press(${JSON.stringify(translatedKey)});
      console.log(\`Pressed key: \${${JSON.stringify(translatedKey)}}\`);
      \n`;
    }
  },

  pprintAction: function (params: KeyPressActionType): string {
    return `Press key "${params.text}"`;
  },
};
