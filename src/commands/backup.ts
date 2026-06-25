import { MongoClient, BSON } from "mongodb";
import { writeFile, readdir, stat } from "fs/promises";
import { join, basename } from "path";

import type { BackupConfig, BackupManifest, CollectionMeta } from "../types/index.js";
import { Spinner, log, section, kv, sanitizeUri, formatBytes, formatDuration } from "../utils/logger.js";
import { checksumFile, compressDir, backupName, dirSize, fileSize } from "../utils/fs.js";
import { uploadToS3 } from "../utils/s3.js";
import { recordBackup } from "../cli/audit.js";
import kleur from "kleur";

let currentBackupDir: string | null = null;

export function getCurrentBackupDir(): string | null {
  return currentBackupDir;
}

export function resetCurrentBackupDir() {
  currentBackupDir = null;
}

function tryJsonStringify(doc: any, index: number): string | null {
  try {
    return JSON.stringify(doc, null, 2);
  } catch {
    return null;
  }
}

function tryBsonSerialize(doc: any, index: number): Buffer | null {
  try {
    const buf = BSON.serialize(doc);
    return Buffer.from(buf.buffer);
  } catch (err: any) {
    return null;
  }
}

export async function runBackup(config: BackupConfig): Promise<string> {
  const startTime = Date.now();
  let failed = false;

  section("Starting Backup");
  kv("Source", sanitizeUri(config.sourceUri));
  kv("Database", config.sourceDb);
  kv("Format", config.format);
  kv("Output", config.outputDir);
  log.blank();

  const spinner = new Spinner("Connecting to MongoDB...").start();
  let client: MongoClient;
  try {
    client = new MongoClient(config.sourceUri, { serverSelectionTimeoutMS: 8000 });
    await client.connect();
    spinner.succeed("Connected to MongoDB");
  } catch (err: any) {
    spinner.fail(`Connection failed: ${err.message}`);
    failed = true;
    recordBackup({
      sourceDb: config.sourceDb, collections: 0, documents: 0,
      outputPath: "", size: "0 B", format: config.format,
      status: "failed", error: err.message,
    }).catch(() => {});
    throw err;
  }

  const db = client.db(config.sourceDb);

  const discoverSpinner = new Spinner("Discovering collections...").start();
  const collections = await db.listCollections({}, { nameOnly: false }).toArray();
  discoverSpinner.succeed(`Found ${kleur.bold(String(collections.length))} collections`);

  if (collections.length === 0) {
    log.warn("Database is empty - no collections to backup");
  }

  const backupDirName = backupName(config.sourceDb);
  const backupDir = join(config.outputDir, backupDirName);
  currentBackupDir = backupDir;
  await Bun.$`mkdir -p ${backupDir}`.quiet();

  const collectionsMeta: CollectionMeta[] = [];
  const checksums: Record<string, string> = {};
  let totalDocs = 0;
  let totalSkipped = 0;

  section("Backing up collections");

  for (const colInfo of collections) {
    const colName = colInfo.name;
    const collection = db.collection(colName);
    const colSpinner = new Spinner(`${kleur.cyan(colName)}`).start();

    try {
      const cursor = collection.find({}).batchSize(500);
      let count = 0;
      let skipped = 0;

      const doJson = config.format === "json" || config.format === "both";
      const doBson = config.format === "bson" || config.format === "both";

      const jsonFile = doJson ? join(backupDir, `${colName}.json`) : null;
      const bsonFile = doBson ? join(backupDir, `${colName}.bson`) : null;

      const jsonWriter = jsonFile ? Bun.file(jsonFile).writer() : null;
      const bsonWriter = bsonFile ? Bun.file(bsonFile).writer() : null;
      const te = new TextEncoder();

      if (jsonWriter) await jsonWriter.write(te.encode("[\n"));

      for await (const doc of cursor) {
        let wrote = false;

        if (jsonWriter) {
          const json = tryJsonStringify(doc, count);
          if (json) {
            if (count > 0) await jsonWriter.write(te.encode(",\n"));
            await jsonWriter.write(te.encode(json));
            wrote = true;
          }
        }
        if (bsonWriter) {
          const buf = tryBsonSerialize(doc, count);
          if (buf) {
            await bsonWriter.write(buf);
            wrote = true;
          }
        }

        if (wrote) {
          count++;
        } else {
          skipped++;
        }
      }

      if (jsonWriter) {
        await jsonWriter.write(te.encode("\n]"));
        await jsonWriter.end();
        checksums[`${colName}.json`] = await checksumFile(jsonFile!);
      }
      if (bsonWriter) {
        await bsonWriter.end();
        checksums[`${colName}.bson`] = await checksumFile(bsonFile!);
      }

      totalDocs += count;
      totalSkipped += skipped;

      const indexes = await collection.indexes();

      collectionsMeta.push({
        name: colName,
        documentCount: count,
        indexes,
        options: {},
        validators: undefined,
      });

      const idxFile = join(backupDir, `${colName}.indexes.json`);
      await writeFile(idxFile, JSON.stringify(indexes, null, 2), "utf-8");
      checksums[`${colName}.indexes.json`] = await checksumFile(idxFile);

      const stats = `${kleur.bold(String(count).padStart(7))} docs` +
        (skipped > 0 ? kleur.yellow(` (${skipped} skipped)`) : "");
      colSpinner.succeed(`${kleur.cyan(colName.padEnd(32))} ${stats}`);
    } catch (err: any) {
      colSpinner.fail(`${colName}: ${err.message}`);
      await Bun.$`rm -rf ${backupDir}`.quiet().catch(() => {});
      throw err;
    }
  }

  const manifest: BackupManifest = {
    version: "1.0.0",
    createdAt: new Date().toISOString(),
    sourceUri: sanitizeUri(config.sourceUri),
    sourceDb: config.sourceDb,
    collections: collectionsMeta,
    checksums,
    totalDocuments: totalDocs,
    format: config.format,
  };

  const manifestFile = join(backupDir, "manifest.json");
  await writeFile(manifestFile, JSON.stringify(manifest, null, 2), "utf-8");
  checksums["manifest.json"] = await checksumFile(manifestFile);
  manifest.checksums["manifest.json"] = checksums["manifest.json"];
  await writeFile(manifestFile, JSON.stringify(manifest, null, 2), "utf-8");

  let finalPath = backupDir;

  if (config.compress && collections.length > 0) {
    const compressSpinner = new Spinner("Compressing backup...").start();
    const tarFile = join(config.outputDir, `${backupDirName}.tar.gz`);
    try {
      await compressDir(backupDir, tarFile);
      await Bun.$`rm -rf ${backupDir}`.quiet();
      manifest.compressedFile = basename(tarFile);
      finalPath = tarFile;
      const size = await fileSize(tarFile);
      compressSpinner.succeed(`Compressed -> ${kleur.bold(tarFile)} ${kleur.gray("(" + formatBytes(size) + ")")}`);
    } catch (err: any) {
      compressSpinner.fail(`Compression failed: ${err.message}`);
      finalPath = backupDir;
    }
  }

  if (config.s3) {
    const s3Spinner = new Spinner("Uploading to S3...").start();
    try {
      const uploadPath = config.compress ? finalPath : manifestFile;
      const s3Filename = config.compress
        ? `${backupDirName}.tar.gz`
        : `${backupDirName}/manifest.json`;
      const s3Location = await uploadToS3(uploadPath, config.s3, s3Filename);
      manifest.s3Location = s3Location;
      s3Spinner.succeed(`Uploaded to ${kleur.cyan(s3Location)}`);
    } catch (err: any) {
      s3Spinner.warn(`S3 upload failed (backup saved locally): ${err.message}`);
    }
  }

  if (config.retention && collections.length > 0) {
    await applyRetention(config.outputDir, config.sourceDb, config.retention);
  }

  await client.close();
  currentBackupDir = null;

  const elapsed = Date.now() - startTime;
  const size = config.compress ? await fileSize(finalPath) : await dirSize(finalPath);

  section("Backup Complete");
  kv("Path", finalPath);
  kv("Collections", String(collectionsMeta.length));
  kv("Total docs", String(totalDocs));
  if (totalSkipped > 0) kv("Skipped", String(totalSkipped));
  kv("Size", formatBytes(size));
  kv("Duration", formatDuration(elapsed));
  log.blank();

  if (!failed) {
    recordBackup({
      sourceDb: config.sourceDb,
      collections: collectionsMeta.length,
      documents: totalDocs,
      outputPath: finalPath,
      size: formatBytes(size),
      format: config.format,
      s3Location: manifest.s3Location ?? null,
      status: "success",
    }).catch(() => {});
  }

  return finalPath;
}

async function applyRetention(
  outputDir: string,
  dbName: string,
  retention: { maxBackups: number; maxAgeDays: number }
) {
  try {
    const entries = await readdir(outputDir);
    if (entries.length === 0) return;

    const escapedName = dbName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`^${escapedName}_\\d{4}-\\d{2}-\\d{2}_\\d{2}-\\d{2}-\\d{2}(\\.tar\\.gz)?$`);

    const backupEntries = entries
      .filter((e) => pattern.test(e))
      .map((e) => ({ name: e, path: join(outputDir, e) }));

    if (backupEntries.length === 0) return;

    backupEntries.sort((a, b) => a.name.localeCompare(b.name));

    const now = Date.now();
    const maxAgeMs = retention.maxAgeDays * 24 * 60 * 60 * 1000;
    const toDelete: string[] = [];

    for (const entry of backupEntries) {
      const stats = await stat(entry.path);
      if (now - stats.mtimeMs > maxAgeMs) {
        toDelete.push(entry.name);
        await Bun.$`rm -rf ${entry.path}`.quiet();
        log.dim(`  Retention: deleted old backup ${entry.name} (age > ${retention.maxAgeDays}d)`);
      }
    }

    const remaining = backupEntries.filter((e) => !toDelete.includes(e.name));
    const excess = remaining.length - retention.maxBackups;
    if (excess > 0) {
      for (let i = 0; i < excess; i++) {
        await Bun.$`rm -rf ${remaining[i]!.path}`.quiet();
        log.dim(`  Retention: deleted oldest backup ${remaining[i]!.name} (max=${retention.maxBackups})`);
      }
    }
  } catch (err: any) {
    log.warn(`Retention cleanup failed: ${err.message}`);
  }
}
