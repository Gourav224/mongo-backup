import { readdir, readFile, stat } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import { tmpdir } from "os";

import type { BackupEntry, BackupManifest } from "../types/index.js";
import { log, section, formatBytes } from "../utils/logger.js";
import { fileSize, dirSize } from "../utils/fs.js";
import kleur from "kleur";

export async function listBackups(outputDir: string): Promise<BackupEntry[]> {
  if (!existsSync(outputDir)) {
    log.warn(`Backup directory does not exist: ${outputDir}`);
    return [];
  }

  const entries = await readdir(outputDir);
  const results: BackupEntry[] = [];

  for (const name of entries) {
    const fullPath = join(outputDir, name);
    let manifest: BackupManifest | null = null;
    let size = 0;

    try {
      if (name.endsWith(".tar.gz")) {
        size = await fileSize(fullPath);
        const tmpDir = join(tmpdir(), `mgback-peek-${Date.now()}`);
        await Bun.$`mkdir -p ${tmpDir}`.quiet();
        const result = await Bun.$`tar -xzf ${fullPath} -C ${tmpDir}`.quiet();
        if (result.exitCode === 0) {
          manifest = await findManifest(tmpDir);
        }
        await Bun.$`rm -rf ${tmpDir}`.quiet();
      } else {
        const s = await stat(fullPath);
        if (!s.isDirectory()) continue;

        const manifestPath = join(fullPath, "manifest.json");
        if (!existsSync(manifestPath)) continue;

        manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
        size = await dirSize(fullPath);
      }

      if (!manifest) continue;

      results.push({
        name,
        path: fullPath,
        manifest,
        size,
        createdAt: new Date(manifest.createdAt),
      });
    } catch {
      // skip unparseable entries
    }
  }

  results.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return results;
}

async function findManifest(dir: string): Promise<BackupManifest | null> {
  const inner = await readdir(dir).catch(() => []);
  for (const entry of inner) {
    const full = join(dir, entry);
    const s = await stat(full).catch(() => null);
    if (s?.isDirectory()) {
      const found = await findManifest(full);
      if (found) return found;
    } else if (entry === "manifest.json") {
      return JSON.parse(await readFile(full, "utf-8"));
    }
  }
  return null;
}

export async function printBackupList(outputDir: string) {
  section("Available Backups");

  const entries = await listBackups(outputDir);

  if (entries.length === 0) {
    log.warn(`No backups found in ${outputDir}`);
    log.blank();
    return;
  }

  const header = [
    kleur.bold().gray("#".padStart(3)),
    kleur.bold().gray("Name".padEnd(46)),
    kleur.bold().gray("DB".padEnd(20)),
    kleur.bold().gray("Collections".padEnd(12)),
    kleur.bold().gray("Docs".padEnd(10)),
    kleur.bold().gray("Size".padEnd(10)),
    kleur.bold().gray("Created"),
  ].join("  ");

  console.log(`  ${header}`);
  console.log("  " + kleur.gray("\u2500".repeat(120)));

  entries.forEach((e, i) => {
    const row = [
      kleur.cyan(String(i + 1).padStart(3)),
      e.name.slice(0, 45).padEnd(46),
      e.manifest.sourceDb.slice(0, 19).padEnd(20),
      String(e.manifest.collections.length).padEnd(12),
      String(e.manifest.totalDocuments).padEnd(10),
      formatBytes(e.size).padEnd(10),
      e.createdAt.toLocaleString(),
    ].join("  ");
    console.log(`  ${row}`);
  });

  log.blank();
  log.dim(`Total: ${entries.length} backup(s) in ${outputDir}`);
  log.blank();
}
