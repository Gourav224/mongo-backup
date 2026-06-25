import { appendJson, appendText } from "./store.js";

export interface HistoryEntry {
  id: string;
  action: "backup" | "restore";
  timestamp: string;
  sourceUri?: string;
  sourceDb?: string;
  targetUri?: string;
  targetDb?: string;
  format?: string;
  outputPath?: string;
  collections?: number;
  documents?: number;
  size?: string;
  s3Location?: string | null;
  status: "success" | "failed";
  error?: string;
}

let seq = 0;

function nextId(): string {
  seq++;
  return `${Date.now().toString(36)}-${seq}`;
}

export async function recordBackup(opts: {
  sourceDb: string;
  collections: number;
  documents: number;
  outputPath: string;
  size: string;
  format: string;
  s3Location?: string | null;
  status: "success" | "failed";
  error?: string;
}) {
  const entry: HistoryEntry = {
    id: nextId(),
    action: "backup",
    timestamp: new Date().toISOString(),
    sourceDb: opts.sourceDb,
    format: opts.format,
    outputPath: opts.outputPath,
    collections: opts.collections,
    documents: opts.documents,
    size: opts.size,
    s3Location: opts.s3Location ?? null,
    status: opts.status,
    error: opts.error,
  };

  await appendJson("history.json", entry);
  await appendText(
    "audit.log",
    `BACKUP  | ${opts.sourceDb} | ${opts.collections} collections, ${opts.documents} docs | ${opts.size} | ${opts.status}`,
  );
}

export async function recordRestore(opts: {
  targetDb: string;
  documents: number;
  backupPath: string;
  status: "success" | "failed";
  error?: string;
}) {
  const entry: HistoryEntry = {
    id: nextId(),
    action: "restore",
    timestamp: new Date().toISOString(),
    targetDb: opts.targetDb,
    outputPath: opts.backupPath,
    documents: opts.documents,
    status: opts.status,
    error: opts.error,
  };

  await appendJson("history.json", entry);
  await appendText(
    "audit.log",
    `RESTORE | ${opts.targetDb} | ${opts.documents} docs restored from ${opts.backupPath} | ${opts.status}`,
  );
}
