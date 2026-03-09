export type UiBlock =
  | SummaryBlock
  | ChecklistBlock
  | StatGridBlock
  | NoteBlock;

export interface SummaryBlock {
  type: "summary";
  title: string;
  body: string;
}

export interface ChecklistBlock {
  type: "checklist";
  title: string;
  items: Array<{
    label: string;
    state: "complete" | "active" | "pending";
  }>;
}

export interface StatGridBlock {
  type: "stat-grid";
  title: string;
  stats: Array<{
    label: string;
    value: string;
  }>;
}

export interface NoteBlock {
  type: "note";
  tone: "info" | "warning" | "success";
  body: string;
}
