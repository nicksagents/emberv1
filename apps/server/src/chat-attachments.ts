import { extname } from "node:path";

import type {
  ChatAttachment,
  ChatAttachmentUpload,
  ChatImageAttachment,
  ChatTextAttachment,
  PreparedAttachmentGroup,
} from "@ember/core";

type CanvasModule = typeof import("@napi-rs/canvas");
type PdfJsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

const MAX_TEXT_ATTACHMENT_CHARS = 24_000;
const MAX_PDF_ATTACHMENT_PAGES = 4;
const MAX_PDF_PAGE_PIXELS = 1_800 * 1_800;
const PDF_IMAGE_MIME_TYPE = "image/png";

const TEXT_MEDIA_TYPES = new Set([
  "application/json",
  "application/ld+json",
  "application/sql",
  "application/toml",
  "application/typescript",
  "application/x-httpd-php",
  "application/x-sh",
  "application/x-yaml",
  "application/xml",
  "application/yaml",
  "image/svg+xml",
]);

const TEXT_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".conf",
  ".cpp",
  ".cs",
  ".css",
  ".csv",
  ".env",
  ".go",
  ".graphql",
  ".h",
  ".hpp",
  ".html",
  ".ini",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".log",
  ".lua",
  ".md",
  ".mjs",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".sh",
  ".sql",
  ".svg",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".c": "c",
  ".cc": "cpp",
  ".conf": "ini",
  ".cpp": "cpp",
  ".cs": "csharp",
  ".css": "css",
  ".csv": "csv",
  ".go": "go",
  ".graphql": "graphql",
  ".h": "c",
  ".hpp": "cpp",
  ".html": "html",
  ".ini": "ini",
  ".java": "java",
  ".js": "javascript",
  ".json": "json",
  ".jsx": "jsx",
  ".lua": "lua",
  ".md": "markdown",
  ".mjs": "javascript",
  ".php": "php",
  ".py": "python",
  ".rb": "ruby",
  ".rs": "rust",
  ".sh": "bash",
  ".sql": "sql",
  ".svg": "xml",
  ".toml": "toml",
  ".ts": "typescript",
  ".tsx": "tsx",
  ".txt": "text",
  ".xml": "xml",
  ".yaml": "yaml",
  ".yml": "yaml",
};

let canvasModulePromise: Promise<CanvasModule> | null = null;
let pdfJsModulePromise: Promise<PdfJsModule> | null = null;

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

function normalizeMediaType(upload: ChatAttachmentUpload): string {
  const mediaType = upload.mediaType.trim().toLowerCase();
  if (mediaType) {
    return mediaType;
  }

  const extension = extname(upload.name).toLowerCase();
  if (extension === ".pdf") {
    return "application/pdf";
  }
  if (TEXT_EXTENSIONS.has(extension)) {
    return "text/plain";
  }

  return "application/octet-stream";
}

function parseDataUrl(dataUrl: string): { mediaType: string; buffer: Buffer } {
  const match = dataUrl.match(/^data:([^;,]+);base64,(.+)$/);
  if (!match) {
    throw new Error("Unsupported attachment encoding.");
  }

  return {
    mediaType: match[1].toLowerCase(),
    buffer: Buffer.from(match[2], "base64"),
  };
}

function inferLanguage(name: string): string | null {
  return LANGUAGE_BY_EXTENSION[extname(name).toLowerCase()] ?? null;
}

function isPdfUpload(upload: ChatAttachmentUpload): boolean {
  return normalizeMediaType(upload) === "application/pdf" || extname(upload.name).toLowerCase() === ".pdf";
}

function isImageUpload(upload: ChatAttachmentUpload): boolean {
  return normalizeMediaType(upload).startsWith("image/");
}

function isTextUpload(upload: ChatAttachmentUpload): boolean {
  const mediaType = normalizeMediaType(upload);
  return (
    mediaType.startsWith("text/") ||
    TEXT_MEDIA_TYPES.has(mediaType) ||
    TEXT_EXTENSIONS.has(extname(upload.name).toLowerCase())
  );
}

function looksBinary(buffer: Buffer): boolean {
  if (buffer.length === 0) {
    return false;
  }

  let suspiciousBytes = 0;
  const sampleSize = Math.min(buffer.length, 4_096);
  for (let index = 0; index < sampleSize; index += 1) {
    const byte = buffer[index];
    if (byte === 0) {
      return true;
    }
    const isPrintable =
      byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte <= 126);
    if (!isPrintable) {
      suspiciousBytes += 1;
    }
  }

  return suspiciousBytes / sampleSize > 0.2;
}

function truncateText(text: string, limit = MAX_TEXT_ATTACHMENT_CHARS): { text: string; truncated: boolean } {
  if (text.length <= limit) {
    return { text, truncated: false };
  }

  return {
    text: `${text.slice(0, limit - 1)}…`,
    truncated: true,
  };
}

function createImageAttachment(params: {
  id: string;
  name: string;
  mediaType: string;
  dataUrl: string;
  sourceId: string;
  sourceName: string;
  pageNumber?: number;
}): ChatImageAttachment {
  return {
    id: params.id,
    kind: "image",
    name: params.name,
    mediaType: params.mediaType,
    dataUrl: params.dataUrl,
    sourceId: params.sourceId,
    sourceName: params.sourceName,
    pageNumber: params.pageNumber ?? null,
  };
}

function createTextAttachment(params: {
  id: string;
  name: string;
  mediaType: string;
  text: string;
  sourceId: string;
  sourceName: string;
  language?: string | null;
  truncated?: boolean;
}): ChatTextAttachment {
  return {
    id: params.id,
    kind: "text",
    name: params.name,
    mediaType: params.mediaType,
    text: params.text,
    sourceId: params.sourceId,
    sourceName: params.sourceName,
    language: params.language ?? null,
    truncated: params.truncated ?? false,
  };
}

async function loadCanvasModule(): Promise<CanvasModule> {
  if (!canvasModulePromise) {
    canvasModulePromise = import("@napi-rs/canvas").catch((error) => {
      canvasModulePromise = null;
      throw new Error(
        `PDF page rendering requires @napi-rs/canvas: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  return canvasModulePromise;
}

async function loadPdfJsModule(): Promise<PdfJsModule> {
  if (!pdfJsModulePromise) {
    pdfJsModulePromise = import("pdfjs-dist/legacy/build/pdf.mjs").catch((error) => {
      pdfJsModulePromise = null;
      throw new Error(
        `PDF parsing requires pdfjs-dist: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  return pdfJsModulePromise;
}

async function prepareImageUpload(upload: ChatAttachmentUpload): Promise<PreparedAttachmentGroup> {
  const mediaType = normalizeMediaType(upload);
  return {
    sourceId: upload.id,
    sourceName: upload.name,
    sourceMediaType: mediaType,
    attachments: [
      createImageAttachment({
        id: upload.id,
        name: upload.name,
        mediaType,
        dataUrl: upload.dataUrl,
        sourceId: upload.id,
        sourceName: upload.name,
      }),
    ],
    summary: "Image attached",
  };
}

async function prepareTextUpload(upload: ChatAttachmentUpload): Promise<PreparedAttachmentGroup> {
  const parsed = parseDataUrl(upload.dataUrl);
  const mediaType = normalizeMediaType(upload);
  if (looksBinary(parsed.buffer)) {
    throw new Error(`${upload.name} looks like a binary file. Only text/code, images, and PDFs are supported.`);
  }

  const rawText = normalizeLineEndings(parsed.buffer.toString("utf8"));
  const { text, truncated } = truncateText(rawText);

  return {
    sourceId: upload.id,
    sourceName: upload.name,
    sourceMediaType: mediaType,
    attachments: [
      createTextAttachment({
        id: upload.id,
        name: upload.name,
        mediaType,
        text,
        sourceId: upload.id,
        sourceName: upload.name,
        language: inferLanguage(upload.name),
        truncated,
      }),
    ],
    summary: truncated ? "Text file attached (truncated)" : "Text file attached",
    warnings: truncated ? [`${upload.name} was truncated to ${MAX_TEXT_ATTACHMENT_CHARS.toLocaleString()} characters.`] : [],
  };
}

async function preparePdfUpload(upload: ChatAttachmentUpload): Promise<PreparedAttachmentGroup> {
  const parsed = parseDataUrl(upload.dataUrl);
  const warnings: string[] = [];
  const { getDocument } = await loadPdfJsModule();
  const { createCanvas } = await loadCanvasModule();
  const pdf = await getDocument({ data: new Uint8Array(parsed.buffer) }).promise;
  const pageNumbers = Array.from(
    { length: Math.min(pdf.numPages, MAX_PDF_ATTACHMENT_PAGES) },
    (_, index) => index + 1,
  );

  if (pdf.numPages > MAX_PDF_ATTACHMENT_PAGES) {
    warnings.push(`Attached the first ${MAX_PDF_ATTACHMENT_PAGES} pages of ${upload.name}.`);
  }

  const pageTextParts: string[] = [];
  const imageAttachments: ChatImageAttachment[] = [];

  for (const pageNumber of pageNumbers) {
    const page = await pdf.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const pageText = textContent.items
      .map((item) => ("str" in item ? String(item.str) : ""))
      .filter(Boolean)
      .join(" ")
      .trim();

    if (pageText) {
      pageTextParts.push(`## Page ${pageNumber}\n${pageText}`);
    }

    const viewport = page.getViewport({ scale: 1 });
    const pagePixels = Math.max(1, viewport.width * viewport.height);
    const scale = Math.min(1.6, Math.max(0.3, Math.sqrt(MAX_PDF_PAGE_PIXELS / pagePixels)));
    const scaledViewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.ceil(scaledViewport.width), Math.ceil(scaledViewport.height));
    await page.render({
      canvas: canvas as unknown as HTMLCanvasElement,
      viewport: scaledViewport,
    }).promise;

    imageAttachments.push(
      createImageAttachment({
        id: `${upload.id}_page_${pageNumber}`,
        name: `${upload.name} page ${pageNumber}`,
        mediaType: PDF_IMAGE_MIME_TYPE,
        dataUrl: `data:${PDF_IMAGE_MIME_TYPE};base64,${canvas.toBuffer(PDF_IMAGE_MIME_TYPE).toString("base64")}`,
        sourceId: upload.id,
        sourceName: upload.name,
        pageNumber,
      }),
    );
  }

  const textAttachment = (() => {
    const rawText = pageTextParts.join("\n\n").trim();
    if (!rawText) {
      return null;
    }

    const { text, truncated } = truncateText(rawText);
    if (truncated) {
      warnings.push(`${upload.name} extracted text was truncated to ${MAX_TEXT_ATTACHMENT_CHARS.toLocaleString()} characters.`);
    }

    return createTextAttachment({
      id: `${upload.id}_text`,
      name: upload.name,
      mediaType: "text/plain",
      text,
      sourceId: upload.id,
      sourceName: upload.name,
      language: "markdown",
      truncated,
    });
  })();

  const attachments: ChatAttachment[] = textAttachment
    ? [textAttachment, ...imageAttachments]
    : imageAttachments;

  if (attachments.length === 0) {
    throw new Error(`No model-readable content could be extracted from ${upload.name}.`);
  }

  return {
    sourceId: upload.id,
    sourceName: upload.name,
    sourceMediaType: "application/pdf",
    attachments,
    summary:
      textAttachment !== null
        ? `PDF attached as ${imageAttachments.length} page images plus extracted text`
        : `PDF attached as ${imageAttachments.length} page images`,
    warnings,
  };
}

export async function prepareAttachmentUpload(upload: ChatAttachmentUpload): Promise<PreparedAttachmentGroup> {
  if (isImageUpload(upload)) {
    return prepareImageUpload(upload);
  }
  if (isPdfUpload(upload)) {
    return preparePdfUpload(upload);
  }
  if (isTextUpload(upload)) {
    return prepareTextUpload(upload);
  }

  throw new Error(`${upload.name} is not a supported attachment type. Use images, PDFs, or text/code files.`);
}

export async function prepareAttachmentUploads(
  uploads: ChatAttachmentUpload[],
): Promise<PreparedAttachmentGroup[]> {
  return Promise.all(uploads.map((upload) => prepareAttachmentUpload(upload)));
}
