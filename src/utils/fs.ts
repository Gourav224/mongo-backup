import { createHash } from "crypto";
import { readdir, stat, readFile } from "fs/promises";
import { join } from "path";

// ─── SHA256 checksum ──────────────────────────────────────────────────────────

export async function checksumFile(filePath: string): Promise<string> {
  const content = await readFile(filePath);
  return createHash("sha256").update(content).digest("hex");
}

export async function checksumBuffer(buf: Buffer): Promise<string> {
  return createHash("sha256").update(buf).digest("hex");
}

export function verifyChecksum(data: Buffer, expected: string): boolean {
  const actual = createHash("sha256").update(data).digest("hex");
  return actual === expected;
}

// ─── tar.gz (pure Bun/Node — no external CLI dependency) ─────────────────────

export async function compressDir(srcDir: string, outFile: string): Promise<void> {
  // Use Bun.spawn to call system tar — available on all Unix systems
  const proc = Bun.spawn(["tar", "-czf", outFile, "-C", srcDir, "."], {
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`tar failed (exit ${exitCode}): ${err}`);
  }
}

export async function decompressToDir(tarFile: string, destDir: string): Promise<void> {
  await Bun.spawn(["mkdir", "-p", destDir]).exited;
  const proc = Bun.spawn(["tar", "-xzf", tarFile, "-C", destDir], {
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`tar extract failed (exit ${exitCode}): ${err}`);
  }
}

// ─── BSON helpers (using mongodb driver's BSON) ───────────────────────────────

// BSON serialization is handled directly in backup.ts / restore.ts
// using the mongodb driver's BSON named export.

// ─── Dir size ─────────────────────────────────────────────────────────────────

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

// ─── Timestamp-based backup name ─────────────────────────────────────────────

export function backupName(dbName: string): string {
  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  return `${dbName}_${ts}`;
}
