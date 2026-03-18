import assert from "node:assert/strict";
import test from "node:test";

import { decodeStreamBuffer, validateAttachmentSelection } from "../components/chat-client";

test("decodeStreamBuffer parses SSE events and ignores heartbeat lines", () => {
  const payload =
    ": stream-open\n\n" +
    "data: {\"type\":\"status\",\"phase\":\"routing\",\"message\":\"Evaluating route...\"}\n\n" +
    "data: {\"type\":\"content\",\"text\":\"hello\"}\n\n";

  const decoded = decodeStreamBuffer(payload);

  assert.equal(decoded.rest, "");
  assert.equal(decoded.events.length, 2);
  assert.equal(decoded.events[0]?.type, "status");
  assert.equal(decoded.events[1]?.type, "content");
});

test("decodeStreamBuffer keeps trailing partial event as rest", () => {
  const payload =
    "data: {\"type\":\"content\",\"text\":\"part-a\"}\n\n" +
    "data: {\"type\":\"content\",\"text\":\"part-b\"}";

  const decoded = decodeStreamBuffer(payload);

  assert.equal(decoded.events.length, 1);
  assert.match(decoded.rest, /part-b/);
});

test("validateAttachmentSelection enforces slot limits and size limits", () => {
  const tooMany = validateAttachmentSelection(
    [
      { name: "a.txt", size: 128 },
      { name: "b.txt", size: 256 },
    ],
    6,
  );
  assert.equal(tooMany.acceptedCount, 0);
  assert.match(tooMany.error ?? "", /up to 6 files/i);

  const oversized = validateAttachmentSelection(
    [{ name: "video.mov", size: 9 * 1024 * 1024 }],
    0,
  );
  assert.equal(oversized.acceptedCount, 0);
  assert.match(oversized.error ?? "", /too large/i);

  const valid = validateAttachmentSelection(
    [
      { name: "one.txt", size: 1024 },
      { name: "two.txt", size: 1024 },
      { name: "three.txt", size: 1024 },
    ],
    4,
  );
  assert.equal(valid.acceptedCount, 2);
  assert.equal(valid.error, null);
});
