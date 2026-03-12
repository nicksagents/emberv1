export interface OcrTextBlock {
  text: string;
  confidence: number | null;
  x: number;
  y: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
}

interface MutableOcrLine {
  words: string[];
  confidenceValues: number[];
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function toNumber(value: string | undefined): number {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

export function normalizeOcrBlocks(blocks: OcrTextBlock[]): OcrTextBlock[] {
  return blocks
    .filter((block) => block.text.trim().length > 0)
    .map((block) => ({
      ...block,
      text: block.text.replace(/\s+/g, " ").trim(),
      centerX: Math.round(block.x + block.width / 2),
      centerY: Math.round(block.y + block.height / 2),
    }))
    .sort((left, right) => left.y - right.y || left.x - right.x);
}

export function parseTesseractTsv(tsv: string): OcrTextBlock[] {
  const lines = tsv.split(/\r?\n/g).filter(Boolean);
  if (lines.length <= 1) {
    return [];
  }

  const headers = lines[0]?.split("\t") ?? [];
  const columnIndex = Object.fromEntries(headers.map((header, index) => [header, index]));
  const groups = new Map<string, MutableOcrLine>();

  for (const rawLine of lines.slice(1)) {
    const columns = rawLine.split("\t");
    const text = (columns[columnIndex.text] ?? "").trim();
    const confidence = toNumber(columns[columnIndex.conf]);
    if (!text || confidence < 0) {
      continue;
    }

    const key = [
      columns[columnIndex.page_num] ?? "0",
      columns[columnIndex.block_num] ?? "0",
      columns[columnIndex.par_num] ?? "0",
      columns[columnIndex.line_num] ?? "0",
    ].join(":");

    const left = toNumber(columns[columnIndex.left]);
    const top = toNumber(columns[columnIndex.top]);
    const width = toNumber(columns[columnIndex.width]);
    const height = toNumber(columns[columnIndex.height]);
    const right = left + width;
    const bottom = top + height;

    const existing = groups.get(key);
    if (existing) {
      existing.words.push(text);
      existing.confidenceValues.push(confidence);
      existing.left = Math.min(existing.left, left);
      existing.top = Math.min(existing.top, top);
      existing.right = Math.max(existing.right, right);
      existing.bottom = Math.max(existing.bottom, bottom);
      continue;
    }

    groups.set(key, {
      words: [text],
      confidenceValues: [confidence],
      left,
      top,
      right,
      bottom,
    });
  }

  return normalizeOcrBlocks(
    [...groups.values()].map((group) => ({
      text: group.words.join(" "),
      confidence:
        group.confidenceValues.length > 0
          ? group.confidenceValues.reduce((sum, value) => sum + value, 0) / group.confidenceValues.length / 100
          : null,
      x: Math.round(group.left),
      y: Math.round(group.top),
      width: Math.round(group.right - group.left),
      height: Math.round(group.bottom - group.top),
      centerX: 0,
      centerY: 0,
    })),
  );
}

export function parseVisionJson(raw: string): OcrTextBlock[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    return [];
  }

  return normalizeOcrBlocks(
    parsed.flatMap((entry): OcrTextBlock[] => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return [];
      }
      const block = entry as Record<string, unknown>;
      if (typeof block.text !== "string" || !block.text.trim()) {
        return [];
      }
      return [
        {
          text: block.text,
          confidence:
            typeof block.confidence === "number" && Number.isFinite(block.confidence)
              ? block.confidence
              : null,
          x: typeof block.x === "number" && Number.isFinite(block.x) ? Math.round(block.x) : 0,
          y: typeof block.y === "number" && Number.isFinite(block.y) ? Math.round(block.y) : 0,
          width: typeof block.width === "number" && Number.isFinite(block.width) ? Math.round(block.width) : 0,
          height: typeof block.height === "number" && Number.isFinite(block.height) ? Math.round(block.height) : 0,
          centerX: 0,
          centerY: 0,
        },
      ];
    }),
  );
}

export function findOcrTextBlocks(blocks: OcrTextBlock[], query: string, maxResults = 10): OcrTextBlock[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return [];
  }

  return blocks
    .filter((block) => block.text.toLowerCase().includes(normalizedQuery))
    .sort((left, right) => {
      const leftExact = left.text.toLowerCase() === normalizedQuery ? 1 : 0;
      const rightExact = right.text.toLowerCase() === normalizedQuery ? 1 : 0;
      return rightExact - leftExact || (right.confidence ?? 0) - (left.confidence ?? 0);
    })
    .slice(0, Math.max(1, Math.floor(maxResults)));
}

export function formatOcrBlocks(blocks: OcrTextBlock[], limit = 20): string {
  if (blocks.length === 0) {
    return "No OCR text blocks were detected.";
  }

  return [
    "OCR text blocks:",
    ...blocks.slice(0, limit).map((block, index) => {
      const confidence = block.confidence !== null ? ` conf=${block.confidence.toFixed(2)}` : "";
      return `${index + 1}. "${block.text}"${confidence} box=(${block.x},${block.y},${block.width}x${block.height}) center=(${block.centerX},${block.centerY})`;
    }),
  ].join("\n");
}
