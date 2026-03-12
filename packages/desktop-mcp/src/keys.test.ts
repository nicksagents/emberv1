import test from "node:test";
import assert from "node:assert/strict";

import { parseKeyChord, toAppleScriptKeySpec, toLinuxKeyChord, toWindowsSendKeys } from "./keys.js";

test("parseKeyChord normalizes modifiers and key", () => {
  assert.deepEqual(parseKeyChord("cmd+shift+L"), {
    key: "l",
    modifiers: ["cmd", "shift"],
  });
});

test("toAppleScriptKeySpec maps named keys to key codes", () => {
  assert.deepEqual(toAppleScriptKeySpec("cmd+enter"), {
    kind: "keycode",
    value: 36,
    modifiers: ["command down"],
  });
});

test("toWindowsSendKeys uses SendKeys syntax", () => {
  assert.equal(toWindowsSendKeys("ctrl+shift+p"), "^+p");
  assert.equal(toWindowsSendKeys("enter"), "{ENTER}");
});

test("toLinuxKeyChord maps modifiers for xdotool", () => {
  assert.equal(toLinuxKeyChord("cmd+l"), "Super+l");
  assert.equal(toLinuxKeyChord("ctrl+shift+escape"), "ctrl+Shift+Escape");
});
