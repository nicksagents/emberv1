import assert from "node:assert/strict";
import test from "node:test";
import { greet } from "../src/index.js";

test("greet returns a stable message", () => {
  assert.match(greet({ audience: "world" }), /world/);
});
