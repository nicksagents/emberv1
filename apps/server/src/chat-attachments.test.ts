import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { prepareAttachmentUpload } from "./chat-attachments.js";

test("prepareAttachmentUpload converts text/code files into text attachments", async () => {
  const payload = Buffer.from("export const answer = 42;\n", "utf8").toString("base64");
  const group = await prepareAttachmentUpload({
    id: "code_1",
    name: "answer.ts",
    mediaType: "text/plain",
    dataUrl: `data:text/plain;base64,${payload}`,
  });

  assert.equal(group.attachments.length, 1);
  const attachment = group.attachments[0];
  assert.equal(attachment.kind, "text");
  if (attachment.kind !== "text") {
    throw new Error("Expected a text attachment.");
  }
  assert.equal(attachment.language, "typescript");
  assert.match(attachment.text, /answer = 42/);
});

test("prepareAttachmentUpload converts PDFs into text plus page images", async (t) => {
  const pdfPath = new URL("../../../repos/Qwen-Agent/examples/resource/doc.pdf", import.meta.url);
  let pdf: Buffer;
  try {
    pdf = await readFile(pdfPath);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: string }).code ?? "")
      : "";
    if (code === "ENOENT") {
      t.skip(`PDF fixture not found for test: ${pdfPath.pathname}`);
      return;
    }
    throw error;
  }
  const group = await prepareAttachmentUpload({
    id: "pdf_1",
    name: "doc.pdf",
    mediaType: "application/pdf",
    dataUrl: `data:application/pdf;base64,${pdf.toString("base64")}`,
  });

  const imageAttachments = group.attachments.filter((attachment) => attachment.kind === "image");
  const textAttachments = group.attachments.filter((attachment) => attachment.kind === "text");

  assert.ok(imageAttachments.length >= 1);
  assert.ok(textAttachments.length >= 1);
  assert.match(group.summary, /PDF attached/);
});
