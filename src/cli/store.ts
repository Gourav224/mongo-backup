import { join } from "path";
import { existsSync } from "fs";
import { readFile, writeFile, appendFile } from "fs/promises";

const STORE_DIR = join(process.cwd(), ".mgback");

export function storePath(name: string): string {
  return join(STORE_DIR, name);
}

export async function ensureStore() {
  if (!existsSync(STORE_DIR)) {
    await Bun.$`mkdir -p ${STORE_DIR}`.quiet();
  }
}

export async function readJson<T>(name: string): Promise<T[]> {
  await ensureStore();
  const path = storePath(name);
  if (!existsSync(path)) return [];
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

export async function writeJson<T>(name: string, data: T[]): Promise<void> {
  await ensureStore();
  const path = storePath(name);
  await writeFile(path, JSON.stringify(data, null, 2), "utf-8");
}

export async function appendJson<T>(name: string, entry: T): Promise<void> {
  const existing = await readJson<T>(name);
  existing.push(entry);
  await writeJson(name, existing);
}

export async function appendText(name: string, line: string): Promise<void> {
  await ensureStore();
  const path = storePath(name);
  const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);
  await appendFile(path, `${timestamp} | ${line}\n`, "utf-8");
}
