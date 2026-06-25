import { MongoClient, BSON } from "mongodb";
import { readFile } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import { tmpdir } from "os";

import type { RestoreConfig, BackupManifest } from "../types/index.js";
import { Spinner, log, section, kv, sanitizeUri, formatDuration } from "../utils/logger.js";
import { checksumFile, decompressToDir } from "../utils/fs.js";
import { runBackup } from "./backup.js";
import kleur from "kleur";

export async function runRestore(config: RestoreConfig): Promise<void> {
  const startTime = Date.now();

  section("Starting Restore");
  kv("Backup", config.backupPath);
  kv("Target URI", sanitizeUri(config.targetUri));
  kv("Target DB", config.targetDb);
  kv("Dry run", config.dryRun ? kleur.yellow("YES - no changes will be made") : "No");
  log.blank();

  let workDir = config.backupPath;
  let tempDir: string | null = null;

  if (config.backupPath.endsWith(".tar.gz")) {
    const decompressSpinner = new Spinner("Decompressing backup...").start();
    tempDir = join(tmpdir(), `mgback-restore-${Date.now()}`);
    try {
      await decompressToDir(config.backupPath, tempDir);
      workDir = tempDir;
      decompressSpinner.succeed("Decompressed to temp dir");
    } catch (err: any) {
      decompressSpinner.fail(`Decompression failed: ${err.message}`);
      throw err;
    }
  }

  const manifestPath = join(workDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`No manifest.json found in backup at ${workDir}`);
  }

  const manifest: BackupManifest = JSON.parse(await readFile(manifestPath, "utf-8"));

  section("Backup Info");
  kv("Created", new Date(manifest.createdAt).toLocaleString());
  kv("Source DB", manifest.sourceDb);
  kv("Collections", String(manifest.collections.length));
  kv("Total docs", String(manifest.totalDocuments));
  kv("Format", manifest.format);
  log.blank();

  const verifySpinner = new Spinner("Verifying checksums...").start();
  let checksumsFailed = 0;

  for (const [filename, expectedHash] of Object.entries(manifest.checksums)) {
    if (filename === "manifest.json") continue;
    const filePath = join(workDir, filename);
    if (!existsSync(filePath)) {
      verifySpinner.warn(`Missing file: ${filename}`);
      checksumsFailed++;
      continue;
    }
    const actual = await checksumFile(filePath);
    if (actual !== expectedHash) {
      verifySpinner.fail(`Checksum mismatch: ${filename}`);
      checksumsFailed++;
    }
  }

  if (checksumsFailed > 0) {
    throw new Error(`${checksumsFailed} checksum(s) failed - backup may be corrupted`);
  }
  verifySpinner.succeed(`All checksums verified (${Object.keys(manifest.checksums).length - 1} files)`);

  if (config.dryRun) {
    section("Dry Run Preview (no changes made)");
    for (const col of manifest.collections) {
      log.info(
        `Would restore ${kleur.bold(col.name.padEnd(32))} -> ${kleur.bold(String(col.documentCount))} docs, ${col.indexes.length} indexes`
      );
    }
    log.blank();
    log.success("Dry run complete. Re-run without --dry-run to apply.");
    return;
  }

  const connectSpinner = new Spinner("Connecting to target MongoDB...").start();
  let client: MongoClient;
  try {
    client = new MongoClient(config.targetUri, { serverSelectionTimeoutMS: 8000 });
    await client.connect();
    connectSpinner.succeed("Connected to target MongoDB");
  } catch (err: any) {
    connectSpinner.fail(`Connection failed: ${err.message}`);
    throw err;
  }

  if (config.autoBackupBeforeRestore) {
    const db = client.db(config.targetDb);
    const existingCols = await db.listCollections().toArray();

    if (existingCols.length > 0) {
      log.warn(`Target DB "${config.targetDb}" has ${existingCols.length} existing collections.`);
      log.info("Auto-backup: taking safety backup of target DB first...");
      try {
        await runBackup({
          sourceUri: config.targetUri,
          sourceDb: config.targetDb,
          outputDir: join(process.cwd(), "backups"),
          format: "both",
          compress: true,
        });
        log.success("Safety backup of target DB complete.");
      } catch (err: any) {
        log.warn(`Safety backup failed: ${err.message} - continuing anyway`);
      }
    }
  }

  const targetDb = client.db(config.targetDb);

  section("Restoring collections");
  let totalRestored = 0;
  const totalCollections = manifest.collections.length;

  for (const [colIdx, colMeta] of manifest.collections.entries()) {
    const progress = kleur.gray(`[${colIdx + 1}/${totalCollections}]`);
    const colSpinner = new Spinner(`${progress} ${kleur.cyan(colMeta.name)}`).start();
    try {
      const collection = targetDb.collection(colMeta.name);

      if (config.dropExisting) {
        await collection.drop().catch(() => {});
      }

      const jsonFile = join(workDir, `${colMeta.name}.json`);
      const bsonFile = join(workDir, `${colMeta.name}.bson`);

      let docs: object[] = [];

      if (existsSync(jsonFile)) {
        const raw = await readFile(jsonFile, "utf-8");
        docs = JSON.parse(raw);
      } else if (existsSync(bsonFile)) {
        const bsonBuf = await readFile(bsonFile);
        let offset = 0;
        while (offset < bsonBuf.length) {
          const size = bsonBuf.readInt32LE(offset);
          if (size < 5 || offset + size > bsonBuf.length) break;
          docs.push(BSON.deserialize(bsonBuf.subarray(offset, offset + size)));
          offset += size;
        }
      } else {
        colSpinner.warn(`${colMeta.name}: no data file found, skipping`);
        continue;
      }

      if (docs.length > 0) {
        const batchSize = 500;
        for (let i = 0; i < docs.length; i += batchSize) {
          await collection.insertMany(docs.slice(i, i + batchSize) as any[], {
            ordered: false,
          });
        }
      }

      const idxFile = join(workDir, `${colMeta.name}.indexes.json`);
      if (existsSync(idxFile)) {
        const indexes = JSON.parse(await readFile(idxFile, "utf-8"));
        for (const idx of indexes) {
          if (idx.name === "_id_") continue;
          const { key, name, ...opts } = idx;
          try {
            await collection.createIndex(key, { name, ...opts });
          } catch {}
        }
      }

      totalRestored += docs.length;
      colSpinner.succeed(
        `${kleur.cyan(colMeta.name.padEnd(32))} ${kleur.bold(String(docs.length).padStart(7))} docs  ${kleur.gray(colMeta.indexes.length + " indexes")}`
      );
    } catch (err: any) {
      colSpinner.fail(`${colMeta.name}: ${err.message}`);
      throw err;
    }
  }

  await client.close();

  if (tempDir) {
    await Bun.$`rm -rf ${tempDir}`.quiet();
  }

  const elapsed = Date.now() - startTime;
  section("Restore Complete");
  kv("Target DB", config.targetDb);
  kv("Collections", String(manifest.collections.length));
  kv("Docs restored", String(totalRestored));
  kv("Duration", formatDuration(elapsed));
  log.blank();
}
