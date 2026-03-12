export interface ParsedKeyChord {
  key: string;
  modifiers: string[];
}

const MODIFIER_ALIASES: Record<string, string> = {
  alt: "alt",
  cmd: "cmd",
  command: "cmd",
  control: "ctrl",
  ctrl: "ctrl",
  meta: "meta",
  option: "alt",
  shift: "shift",
  super: "meta",
  win: "meta",
  windows: "meta",
};

const APPLE_MODIFIERS: Record<string, string> = {
  alt: "option down",
  cmd: "command down",
  ctrl: "control down",
  meta: "command down",
  shift: "shift down",
};

const APPLE_KEY_CODES: Record<string, number> = {
  backspace: 51,
  delete: 51,
  down: 125,
  end: 119,
  enter: 36,
  esc: 53,
  escape: 53,
  home: 115,
  left: 123,
  pagedown: 121,
  pageup: 116,
  return: 36,
  right: 124,
  space: 49,
  tab: 48,
  up: 126,
};

const WINDOWS_MODIFIERS: Record<string, string> = {
  alt: "%",
  cmd: "#",
  ctrl: "^",
  meta: "#",
  shift: "+",
};

const WINDOWS_KEYS: Record<string, string> = {
  backspace: "{BACKSPACE}",
  delete: "{DELETE}",
  down: "{DOWN}",
  end: "{END}",
  enter: "{ENTER}",
  esc: "{ESC}",
  escape: "{ESC}",
  home: "{HOME}",
  left: "{LEFT}",
  pagedown: "{PGDN}",
  pageup: "{PGUP}",
  return: "{ENTER}",
  right: "{RIGHT}",
  space: " ",
  tab: "{TAB}",
  up: "{UP}",
};

const LINUX_KEY_ALIASES: Record<string, string> = {
  alt: "Alt",
  backspace: "BackSpace",
  cmd: "Super",
  control: "ctrl",
  ctrl: "ctrl",
  delete: "BackSpace",
  down: "Down",
  end: "End",
  enter: "Return",
  esc: "Escape",
  escape: "Escape",
  home: "Home",
  left: "Left",
  meta: "Super",
  pagedown: "Next",
  pageup: "Prior",
  return: "Return",
  right: "Right",
  shift: "Shift",
  space: "space",
  super: "Super",
  tab: "Tab",
  up: "Up",
  win: "Super",
};

export function parseKeyChord(chord: string): ParsedKeyChord {
  const tokens = chord
    .split("+")
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);

  if (tokens.length === 0) {
    throw new Error("Key chord is required.");
  }

  const modifiers: string[] = [];
  let key: string | null = null;
  for (const token of tokens) {
    const modifier = MODIFIER_ALIASES[token];
    if (modifier) {
      if (!modifiers.includes(modifier)) {
        modifiers.push(modifier);
      }
      continue;
    }
    if (key) {
      throw new Error(`Key chord "${chord}" must contain exactly one non-modifier key.`);
    }
    key = token;
  }

  if (!key) {
    throw new Error(`Key chord "${chord}" is missing the key to press.`);
  }

  return { key, modifiers };
}

export function toAppleScriptKeySpec(chord: string): {
  kind: "keycode" | "keystroke";
  value: number | string;
  modifiers: string[];
} {
  const parsed = parseKeyChord(chord);
  const keyCode = APPLE_KEY_CODES[parsed.key];
  return {
    kind: keyCode !== undefined ? "keycode" : "keystroke",
    value: keyCode !== undefined ? keyCode : parsed.key,
    modifiers: parsed.modifiers.map((modifier) => APPLE_MODIFIERS[modifier] ?? modifier),
  };
}

export function toWindowsSendKeys(chord: string): string {
  const parsed = parseKeyChord(chord);
  const modifiers = parsed.modifiers.map((modifier) => WINDOWS_MODIFIERS[modifier] ?? "").join("");
  const key = WINDOWS_KEYS[parsed.key] ?? parsed.key;
  return `${modifiers}${key}`;
}

export function toLinuxKeyChord(chord: string): string {
  const parsed = parseKeyChord(chord);
  const modifiers = parsed.modifiers.map((modifier) => LINUX_KEY_ALIASES[modifier] ?? modifier);
  const key = LINUX_KEY_ALIASES[parsed.key] ?? parsed.key;
  return [...modifiers, key].join("+");
}
