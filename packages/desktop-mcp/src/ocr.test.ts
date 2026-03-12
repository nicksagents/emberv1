import assert from "node:assert/strict";
import test from "node:test";

import { findOcrTextBlocks, formatOcrBlocks, parseTesseractTsv, parseVisionJson } from "./ocr.js";

test("parseTesseractTsv aggregates words into line blocks", () => {
  const tsv = [
    "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
    "5\t1\t1\t1\t1\t1\t100\t200\t40\t18\t95\tSign",
    "5\t1\t1\t1\t1\t2\t145\t200\t22\t18\t93\tin",
    "5\t1\t1\t1\t2\t1\t100\t240\t55\t18\t90\tContinue",
  ].join("\n");

  const blocks = parseTesseractTsv(tsv);

  assert.equal(blocks.length, 2);
  assert.equal(blocks[0]?.text, "Sign in");
  assert.deepEqual(
    blocks[0] && [blocks[0].x, blocks[0].y, blocks[0].width, blocks[0].height, blocks[0].centerX, blocks[0].centerY],
    [100, 200, 67, 18, 134, 209],
  );
});

test("parseVisionJson normalizes OCR blocks", () => {
  const blocks = parseVisionJson(
    JSON.stringify([
      { text: "Open", confidence: 0.99, x: 10, y: 20, width: 50, height: 16 },
      { text: "Mail", confidence: 0.92, x: 70, y: 20, width: 40, height: 16 },
    ]),
  );

  assert.equal(blocks.length, 2);
  assert.equal(blocks[0]?.centerX, 35);
  assert.equal(blocks[0]?.centerY, 28);
});

test("findOcrTextBlocks ranks exact matches first", () => {
  const blocks = parseVisionJson(
    JSON.stringify([
      { text: "Sign in", confidence: 0.7, x: 10, y: 10, width: 60, height: 18 },
      { text: "Sign in to continue", confidence: 0.95, x: 10, y: 40, width: 140, height: 18 },
    ]),
  );

  const matches = findOcrTextBlocks(blocks, "Sign in");
  assert.equal(matches[0]?.text, "Sign in");
});

test("formatOcrBlocks renders center coordinates", () => {
  const blocks = parseVisionJson(
    JSON.stringify([{ text: "Submit", confidence: 0.88, x: 20, y: 30, width: 80, height: 22 }]),
  );
  const formatted = formatOcrBlocks(blocks);
  assert.match(formatted, /center=\(60,41\)/);
});
