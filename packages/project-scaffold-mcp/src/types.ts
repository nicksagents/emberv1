export type TemplateScalar = string | number | boolean;

export interface TemplateOption {
  key: string;
  label: string;
  description: string;
  type: "string" | "number" | "boolean" | "enum";
  required?: boolean;
  default?: TemplateScalar;
  enumValues?: string[];
}

export interface TemplateManifest {
  id: string;
  title: string;
  description: string;
  stack: string;
  kind: string;
  tags: string[];
  defaults?: Record<string, TemplateScalar>;
  options?: TemplateOption[];
  setupCommands?: string[];
  followUpCommands?: string[];
  entrypoints?: string[];
  directorNotes?: string[];
}

export interface TemplateRecord {
  manifest: TemplateManifest;
  templateDir: string;
  filesDir: string;
}

export interface ScaffoldMetadata {
  templateId: string;
  templateTitle: string;
  stack: string;
  kind: string;
  targetDir: string;
  projectName: string;
  createdAt: string;
  variables: Record<string, TemplateScalar>;
  entrypoints: string[];
  directorNotes: string[];
  setupCommands: string[];
  followUpCommands: string[];
}
