import { MongoClient, BSON } from "mongodb";
import { mkdir, writeFile, readdir } from "fs/promises";
import { join, basename } from "path";
import { existsSync } from "fs";

import type { BackupConfig, BackupManifest, CollectionMeta } from "../types/index.js";
import { Spinner, log, section, kv, sanitizeUri, formatBytes, formatDuration } from "../utils/logger.js";
import { checksumFile, compressDir, backupName, dirSize, fileSize } from "../utils/fs.js";
import { uploadToS3 } from "../utils/s3.js";
import kleur from "kleur";

export async function runBackup(config: BackupConfig): Promise<string> {
  const startTime = Date.now();

  section("📦 Starting Backup");
  kv("Source", sanitizeUri(config.sourceUri));
  kv("Database", config.sourceDb);
  kv("Format", config.format);
  kv("Output", config.outputDir);
  log.blank();

  // ── Connect ──────────────────────────────────────────────────────────────
  const spinner = new Spinner("Connecting to MongoDB…").start();
  let client: MongoClient;
  try {
    client = new MongoClient(config.sourceUri, { serverSelectionTimeoutMS: 8000 });
    await client.connect();
    spinner.succeed("Connected to MongoDB");
  } catch (err: any) {
    spinner.fail(`Connection failed: ${err.message}`);
    throw err;
  }

  const db = client.db(config.sourceDb);

  // ── Discover collections ─────────────────────────────────────────────────
  const discoverSpinner = new Spinner("Discovering collections…").start();
  const collections = await db.listCollections({}, { nameOnly: false }).toArray();
  discoverSpinner.succeed(`Found ${kleur.bold(String(collections.length))} collections`);

  // ── Create output dir ─────────────────────────────────────────────────────
  const backupDirName = backupName(config.sourceDb);
  const backupDir = join(config.outputDir, backupDirName);
  await mkdir(backupDir, { recursive: true });

  const collectionsMeta: CollectionMeta[] = [];
  const checksums: Record<string, string> = {};
  let totalDocs = 0;

  // ── Backup each collection ────────────────────────────────────────────────
  section("🗂  Backing up collections");

  for (const colInfo of collections) {
    const colName = colInfo.name;
    const collection = db.collection(colName);

    const countSpinner = new Spinner(`${kleur.cyan(colName)}`).start();

    try {
      // Fetch all documents
      const docs = await collection.find({}).toArray();
      const count = docs.length;
      totalDocs += count;

      // Fetch indexes
      const indexes = await collection.indexes();

      // Store metadata
      const meta: CollectionMeta = {
        name: colName,
        documentCount: count,
        indexes,
        options: colInfo.options || {},
        validators: (colInfo.options as any)?.validator,
      };
      collectionsMeta.push(meta);

      // ── Write JSON ───────────────────────────────────────────────────────
      if (config.format === "json" || config.format === "both") {
        const jsonFile = join(backupDir, `${colName}.json`);
        await writeFile(jsonFile, JSON.stringify(docs, null, 2), "utf-8");
        const cksum = await checksumFile(jsonFile);
        checksums[`${colName}.json`] = cksum;
      }

      // ── Write BSON ───────────────────────────────────────────────────────
      if (config.format === "bson" || config.format === "both") {
        const bsonFile = join(backupDir, `${colName}.bson`);
        const chunks: Uint8Array[] = docs.map((doc) => BSON.serialize(doc));
        const combined = Buffer.concat(chunks);
        await writeFile(bsonFile, combined);
        const cksum = await checksumFile(bsonFile);
        checksums[`${colName}.bson`] = cksum;
      }

      // ── Write indexes ────────────────────────────────────────────────────
      const idxFile = join(backupDir, `${colName}.indexes.json`);
      await writeFile(idxFile, JSON.stringify(indexes, null, 2), "utf-8");
      checksums[`${colName}.indexes.json`] = await checksumFile(idxFile);

      countSpinner.succeed(
        `${kleur.cyan(colName.padEnd(32))} ${kleur.bold(String(count).padStart(7))} docs`
      );
    } catch (err: any) {
      countSpinner.fail(`${colName}: ${err.message}`);
      throw err;
    }
  }

  // ── Write manifest ────────────────────────────────────────────────────────
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
  // Re-write with manifest's own checksum
  manifest.checksums["manifest.json"] = checksums["manifest.json"];
  await writeFile(manifestFile, JSON.stringify(manifest, null, 2), "utf-8");

  let finalPath = backupDir;

  // ── Compress ──────────────────────────────────────────────────────────────
  if (config.compress) {
    const compressSpinner = new Spinner("Compressing backup…").start();
    const tarFile = join(config.outputDir, `${backupDirName}.tar.gz`);
    try {
      await compressDir(backupDir, tarFile);
      // Remove uncompressed dir
      await Bun.spawn(["rm", "-rf", backupDir]).exited;
      manifest.compressedFile = basename(tarFile);
      finalPath = tarFile;
      const size = await fileSize(tarFile);
      compressSpinner.succeed(`Compressed → ${kleur.bold(tarFile)} ${kleur.gray("(" + formatBytes(size) + ")")}`);
    } catch (err: any) {
      compressSpinner.fail(`Compression failed: ${err.message}`);
      // Keep uncompressed dir as fallback
      finalPath = backupDir;
    }
  }

  // ── Upload to S3 ─────────────────────────────────────────────────────────
  if (config.s3) {
    const s3Spinner = new Spinner("Uploading to S3…").start();
    try {
      const filename = config.compress
        ? `${backupDirName}.tar.gz`
        : `${backupDirName}-manifest.json`;
      const s3Location = await uploadToS3(
        config.compress ? finalPath : manifestFile,
        config.s3,
        config.compress ? `${backupDirName}.tar.gz` : `${backupDirName}/manifest.json`
      );
      manifest.s3Location = s3Location;
      s3Spinner.succeed(`Uploaded to ${kleur.cyan(s3Location)}`);
    } catch (err: any) {
      s3Spinner.warn(`S3 upload failed (backup still saved locally): ${err.message}`);
    }
  }

  // ── Retention policy ─────────────────────────────────────────────────────
  if (config.retention) {
    await applyRetention(config.outputDir, config.sourceDb, config.retention);
  }

  await client.close();

  // ── Summary ───────────────────────────────────────────────────────────────
  const elapsed = Date.now() - startTime;
  const size = config.compress ? await fileSize(finalPath) : await dirSize(finalPath);

  section("✅ Backup Complete");
  kv("Path", finalPath);
  kv("Collections", String(collectionsMeta.length));
  kv("Total docs", String(totalDocs));
  kv("Size", formatBytes(size));
  kv("Duration", formatDuration(elapsed));
  log.blank();

  return finalPath;
}

async function applyRetention(
  outputDir: string,
  dbName: string,
  retention: { maxBackups: number; maxAgeDays: number }
) {
  try {
    const entries = await readdir(outputDir);
    const pattern = new RegExp(`^${dbName}_\\d{4}-\\d{2}-\\d{2}_\\d{2}-\\d{2}-\\d{2}(\\.tar\\.gz)?$`);

    const backupEntries = entries
      .filter((e) => pattern.test(e))
      .map((e) => ({ name: e, path: join(outputDir, e) }));

    // Sort by name (timestamp-based names sort lexicographically)
    backupEntries.sort((a, b) => a.name.localeCompare(b.name));

    const now = Date.now();
    const maxAgeMs = retention.maxAgeDays * 24 * 60 * 60 * 1000;
    let deleted = 0;

    for (const entry of backupEntries) {
      const { default: fs } = await import("fs");
      const stats = fs.statSync(entry.path);
      const age = now - stats.mtimeMs;

      if (age > maxAgeMs) {
        await Bun.spawn(["rm", "-rf", entry.path]).exited;
        log.dim(`  Retention: deleted old backup ${entry.name} (age > ${retention.maxAgeDays}d)`);
        deleted++;
      }
    }

    // After age deletion, check count
    const remaining = backupEntries.filter((_, i) => i >= deleted);
    const tooMany = remaining.length - retention.maxBackups;
    if (tooMany > 0) {
      for (let i = 0; i < tooMany; i++) {
        await Bun.spawn(["rm", "-rf", remaining[i].path]).exited;
        log.dim(`  Retention: deleted oldest backup ${remaining[i].name} (max=${retention.maxBackups})`);
      }
    }
  } catch (err: any) {
    log.warn(`Retention cleanup failed: ${err.message}`);
  }
}
