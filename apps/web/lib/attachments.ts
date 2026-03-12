import type {
  ChatAttachment,
  ChatImageAttachment,
  ChatTextAttachment,
  PreparedAttachmentGroup,
} from "@ember/core/client";

export function isImageAttachment(attachment: ChatAttachment): attachment is ChatImageAttachment {
  return attachment.kind === "image";
}

export function isTextAttachment(attachment: ChatAttachment): attachment is ChatTextAttachment {
  return attachment.kind === "text";
}

export function flattenAttachmentGroups(groups: PreparedAttachmentGroup[]): ChatAttachment[] {
  return groups.flatMap((group) => group.attachments);
}

export function summarizeAttachmentGroup(
  attachments: ChatAttachment[],
  sourceName: string,
): string {
  const imageCount = attachments.filter(isImageAttachment).length;
  const textCount = attachments.filter(isTextAttachment).length;
  const isPdf = sourceName.toLowerCase().endsWith(".pdf");

  if (isPdf) {
    if (imageCount > 0 && textCount > 0) {
      return `PDF attached as ${imageCount} page images plus extracted text`;
    }
    if (imageCount > 0) {
      return `PDF attached as ${imageCount} page images`;
    }
  }

  if (textCount > 0 && imageCount === 0) {
    return attachments.some((attachment) => attachment.kind === "text" && attachment.truncated)
      ? "Text file attached (truncated)"
      : "Text file attached";
  }

  if (imageCount > 0 && textCount === 0) {
    return imageCount === 1 ? "Image attached" : `${imageCount} images attached`;
  }

  return "Attachments ready";
}

export function groupAttachments(attachments: ChatAttachment[]): PreparedAttachmentGroup[] {
  const groups = new Map<string, PreparedAttachmentGroup>();

  for (const attachment of attachments) {
    const sourceId = attachment.sourceId ?? attachment.id;
    const sourceName = attachment.sourceName ?? attachment.name;
    const existing = groups.get(sourceId);
    if (existing) {
      existing.attachments.push(attachment);
      continue;
    }

    groups.set(sourceId, {
      sourceId,
      sourceName,
      sourceMediaType: attachment.mediaType,
      attachments: [attachment],
      summary: "",
      warnings: [],
    });
  }

  return [...groups.values()].map((group) => ({
    ...group,
    summary: summarizeAttachmentGroup(group.attachments, group.sourceName),
  }));
}
