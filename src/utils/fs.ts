import { createHash } from "crypto";
import { readdir, stat, readFile } from "fs/promises";
import { join } from "path";

export async function checksumFile(filePath: string): Promise<string> {
  const content = await readFile(filePath);
  return createHash("sha256").update(content).digest("hex");
}

export async function compressDir(srcDir: string, outFile: string): Promise<void> {
  const result = await Bun.$`tar -czf ${outFile} -C ${srcDir} .`.quiet();
  if (result.exitCode !== 0) {
    throw new Error(`tar failed (exit ${result.exitCode}): ${result.stderr.toString()}`);
  }
}

export async function decompressToDir(tarFile: string, destDir: string): Promise<void> {
  await Bun.$`mkdir -p ${destDir}`.quiet();
  const result = await Bun.$`tar -xzf ${tarFile} -C ${destDir}`.quiet();
  if (result.exitCode !== 0) {
    throw new Error(`tar extract failed (exit ${result.exitCode}): ${result.stderr.toString()}`);
  }
}

export async function dirSize(dirPath: string): Promise<number> {
  let total = 0;
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const e of entries) {
      const full = join(dirPath, e.name);
      if (e.isDirectory()) {
        total += await dirSize(full);
      } else {
        const s = await stat(full);
        total += s.size;
      }
    }
  } catch {}
  return total;
}

export async function fileSize(filePath: string): Promise<number> {
  try {
    const s = await stat(filePath);
    return s.size;
  } catch {
    return 0;
  }
}

export function backupName(dbName: string): string {
  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  return `${dbName}_${ts}`;
}
