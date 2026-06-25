#!/usr/bin/env bun
import { join } from "path";
import { existsSync } from "fs";
import { mkdir } from "fs/promises";
import kleur from "kleur";

import { banner, log, section, kv, sanitizeUri } from "./utils/logger.js";
import { prompt, promptPassword, confirm, select, multiSelect } from "./utils/prompt.js";
import { s3ConfigFromEnv } from "./utils/s3.js";
import { runBackup } from "./commands/backup.js";
import { runRestore } from "./commands/restore.js";
import { listBackups, printBackupList } from "./commands/list.js";
import type { BackupConfig, RestoreConfig, S3Config } from "./types/index.js";

const DEFAULT_URI = Bun.env.MONGODB_URI || Bun.env.MONGO_URI || "";
const DEFAULT_OUTPUT = Bun.env.BACKUP_OUTPUT_DIR || join(process.cwd(), "backups");
const DEFAULT_RETENTION_MAX = parseInt(Bun.env.BACKUP_RETENTION_MAX || "10");
const DEFAULT_RETENTION_DAYS = parseInt(Bun.env.BACKUP_RETENTION_DAYS || "30");

const args = Bun.argv.slice(2);
const flags = {
  dryRun: args.includes("--dry-run"),
  verbose: args.includes("--verbose") || args.includes("-v"),
  noColor: args.includes("--no-color"),
  help: args.includes("--help") || args.includes("-h"),
};

const command = args.find((a) => !a.startsWith("-")) as
  | "backup"
  | "restore"
  | "list"
  | undefined;

if (flags.noColor) kleur.enabled = false;

function printHelp() {
  banner();
  console.log(`  ${kleur.bold("Usage:")}`);
  console.log(`    bun run src/index.ts ${kleur.cyan("[command]")} ${kleur.gray("[flags]")}\n`);
  console.log(`  ${kleur.bold("Commands:")}`);
  console.log(`    ${kleur.cyan("backup")}   - Take a full backup of a MongoDB database`);
  console.log(`    ${kleur.cyan("restore")}  - Restore a backup to a MongoDB database`);
  console.log(`    ${kleur.cyan("list")}     - List available backups\n`);
  console.log(`  ${kleur.bold("Flags:")}`);
  console.log(`    ${kleur.gray("--dry-run")}    Preview restore without making changes`);
  console.log(`    ${kleur.gray("--verbose")}    Show detailed logs`);
  console.log(`    ${kleur.gray("--no-color")}   Disable colors`);
  console.log(`    ${kleur.gray("--help")}       Show this help\n`);
  console.log(`  ${kleur.bold("Environment:")}`);
  console.log(`    ${kleur.gray("MONGODB_URI")}              Default source MongoDB URI`);
  console.log(`    ${kleur.gray("BACKUP_OUTPUT_DIR")}        Default backup directory`);
  console.log(`    ${kleur.gray("BACKUP_RETENTION_MAX")}     Max backups to keep (default: 10)`);
  console.log(`    ${kleur.gray("BACKUP_RETENTION_DAYS")}    Delete backups older than N days (default: 30)`);
  console.log(`    ${kleur.gray("BACKUP_S3_BUCKET")}         S3 bucket for uploads`);
  console.log(`    ${kleur.gray("BACKUP_S3_REGION")}         S3 region`);
  console.log(`    ${kleur.gray("BACKUP_S3_PREFIX")}         S3 key prefix`);
  console.log(`    ${kleur.gray("AWS_ACCESS_KEY_ID")}        AWS credentials`);
  console.log(`    ${kleur.gray("AWS_SECRET_ACCESS_KEY")}    AWS credentials`);
  console.log(`    ${kleur.gray("BACKUP_S3_ENDPOINT")}       Custom S3-compatible endpoint\n`);
  console.log(`  ${kleur.bold("Examples:")}`);
  console.log(`    ${kleur.gray("bun run src/index.ts backup")}`);
  console.log(`    ${kleur.gray("bun run src/index.ts restore --dry-run")}`);
  console.log(`    ${kleur.gray("bun run src/index.ts list")}\n`);
}

async function askMongoUri(label: string, defaultUri?: string): Promise<string> {
  if (defaultUri) {
    log.info(`Using ${label} from environment: ${kleur.cyan(sanitizeUri(defaultUri))}`);
    const useDefault = await confirm("Use this connection string?", true);
    if (useDefault) return defaultUri;
  }

  const type = await select(`${label} - connection type`, [
    { label: "MongoDB Atlas (connection string)", value: "atlas", hint: "mongodb+srv://..." },
    { label: "Local MongoDB", value: "local", hint: "mongodb://localhost:27017" },
    { label: "Custom URI", value: "custom", hint: "full connection string" },
  ]);

  if (type === "local") {
    const host = await prompt("Host", "localhost");
    const port = await prompt("Port", "27017");
    const useAuth = await confirm("Does it require authentication?", false);
    if (useAuth) {
      const user = await prompt("Username");
      const pass = await promptPassword("Password");
      return `mongodb://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
    }
    return `mongodb://${host}:${port}`;
  }

  if (type === "atlas") {
    log.dim(`  Format: mongodb+srv://<user>:<password>@<cluster>.mongodb.net`);
    const uri = await prompt("Atlas connection string");
    return uri;
  }

  const uri = await prompt("Full MongoDB URI");
  return uri;
}

async function interactiveBackup() {
  section("Configure Backup");

  const sourceUri = await askMongoUri("Source MongoDB", DEFAULT_URI);
  const sourceDb = await prompt("Source database name");
  if (!sourceDb) throw new Error("Database name is required");

  const outputDir = await prompt("Backup output directory", DEFAULT_OUTPUT);
  await mkdir(outputDir, { recursive: true });

  const format = await select("Backup format", [
    { label: "Both JSON + BSON", value: "both", hint: "recommended - most compatible" },
    { label: "JSON only", value: "json", hint: "human-readable" },
    { label: "BSON only", value: "bson", hint: "compact, binary" },
  ]);

  let s3Config: S3Config | undefined;
  const envS3 = s3ConfigFromEnv();
  if (envS3) {
    log.info(`S3 configured via env: ${kleur.cyan(`s3://${envS3.bucket}/${envS3.prefix}`)}`);
    const useS3 = await confirm("Upload backup to S3?", true);
    if (useS3) s3Config = envS3;
  } else {
    const wantS3 = await confirm("Upload backup to S3?", false);
    if (wantS3) {
      const bucket = await prompt("S3 bucket name");
      const region = await prompt("AWS region", "us-east-1");
      const prefix = await prompt("S3 key prefix", "mongo-backups");
      const accessKeyId = await prompt("AWS_ACCESS_KEY_ID (leave blank to use env/IAM)");
      const secretAccessKey = accessKeyId
        ? await promptPassword("AWS_SECRET_ACCESS_KEY")
        : "";
      const endpoint = await prompt("Custom S3 endpoint (leave blank for AWS)");
      s3Config = {
        bucket,
        region,
        prefix,
        ...(accessKeyId && { accessKeyId }),
        ...(secretAccessKey && { secretAccessKey }),
        ...(endpoint && { endpoint }),
      };
    }
  }

  const wantRetention = await confirm("Enable retention policy?", true);
  const retention = wantRetention
    ? {
        maxBackups: parseInt(await prompt("Max backups to keep", String(DEFAULT_RETENTION_MAX))),
        maxAgeDays: parseInt(await prompt("Delete backups older than (days)", String(DEFAULT_RETENTION_DAYS))),
      }
    : undefined;

  section("Summary");
  kv("Source", sanitizeUri(sourceUri));
  kv("Database", sourceDb);
  kv("Format", format);
  kv("Output", outputDir);
  kv("S3 upload", s3Config ? `s3://${s3Config.bucket}/${s3Config.prefix}` : "No");
  kv(
    "Retention",
    retention ? `max ${retention.maxBackups} backups, ${retention.maxAgeDays} days` : "Disabled"
  );
  log.blank();

  const ok = await confirm("Proceed with backup?", true);
  if (!ok) {
    log.warn("Backup cancelled.");
    process.exit(0);
  }

  const config: BackupConfig = {
    sourceUri,
    sourceDb,
    outputDir,
    format: format as "json" | "bson" | "both",
    compress: true,
    s3: s3Config,
    retention,
  };

  await runBackup(config);
}

async function interactiveRestore() {
  section("Configure Restore");

  const outputDir = await prompt("Backup directory", DEFAULT_OUTPUT);
  const entries = await listBackups(outputDir);

  let backupPath: string;

  if (entries.length > 0) {
    await printBackupList(outputDir);

    const pickMethod = await select("Select backup to restore", [
      { label: "Pick from list above", value: "list" },
      { label: "Enter path manually", value: "manual" },
    ]);

    if (pickMethod === "list") {
      const idx = parseInt(await prompt(`Enter backup number (1-${entries.length})`)) - 1;
      if (idx < 0 || idx >= entries.length) throw new Error("Invalid backup selection");
      backupPath = entries[idx]!.path;
      log.info(`Selected: ${kleur.cyan(entries[idx]!.name)}`);
    } else {
      backupPath = await prompt("Full path to backup file or directory");
    }
  } else {
    log.warn("No backups found in that directory.");
    backupPath = await prompt("Full path to backup file or directory");
  }

  if (!existsSync(backupPath)) {
    throw new Error(`Backup not found: ${backupPath}`);
  }

  const targetType = await select("Where to restore?", [
    {
      label: "Same Atlas cluster - different DB name",
      value: "same-cluster",
      hint: "e.g. prod_db -> prod_db_restore",
    },
    {
      label: "Different Atlas cluster",
      value: "different-atlas",
      hint: "paste a different Atlas URI",
    },
    {
      label: "Local MongoDB",
      value: "local",
      hint: "mongodb://localhost:27017",
    },
    {
      label: "Custom URI",
      value: "custom",
      hint: "any connection string",
    },
  ]);

  let targetUri: string;
  let targetDb: string;

  if (targetType === "same-cluster") {
    log.info("You need the actual connection string (manifest stores a sanitized version).");
    targetUri = await askMongoUri("Same cluster URI", DEFAULT_URI);
    const sourceDb = entries.find((e) => e.path === backupPath)?.manifest.sourceDb || "db";
    targetDb = await prompt("New database name", `${sourceDb}_restore`);
  } else if (targetType === "different-atlas") {
    targetUri = await askMongoUri("Target Atlas URI");
    targetDb = await prompt("Target database name");
  } else if (targetType === "local") {
    const host = await prompt("Host", "localhost");
    const port = await prompt("Port", "27017");
    const useAuth = await confirm("Requires authentication?", false);
    if (useAuth) {
      const user = await prompt("Username");
      const pass = await promptPassword("Password");
      targetUri = `mongodb://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
    } else {
      targetUri = `mongodb://${host}:${port}`;
    }
    targetDb = await prompt("Target database name");
  } else {
    targetUri = await prompt("Full target MongoDB URI");
    targetDb = await prompt("Target database name");
  }

  const dropExisting = await confirm(
    `Drop existing collections in "${targetDb}" before restore?`,
    false
  );
  const autoBackupBeforeRestore = await confirm(
    "Auto-backup target DB before restoring (safety net)?",
    true
  );
  const dryRun = flags.dryRun || (await confirm("Do a dry run first (preview only)?", true));

  section("Restore Summary");
  kv("Backup", backupPath);
  kv("Target URI", sanitizeUri(targetUri));
  kv("Target DB", targetDb);
  kv("Drop existing", dropExisting ? kleur.yellow("YES") : "No");
  kv("Auto-backup first", autoBackupBeforeRestore ? "Yes" : "No");
  kv("Dry run", dryRun ? kleur.yellow("YES - preview only") : "No (LIVE)");
  log.blank();

  if (!dryRun) {
    log.warn("This will write data to the target database. This cannot be undone.");
    const sure = await confirm("Are you sure you want to proceed?", false);
    if (!sure) {
      log.warn("Restore cancelled.");
      process.exit(0);
    }
  }

  const config: RestoreConfig = {
    backupPath,
    targetUri,
    targetDb,
    dryRun,
    dropExisting,
    autoBackupBeforeRestore,
  };

  await runRestore(config);

  if (dryRun) {
    const runForReal = await confirm("Dry run complete. Run the actual restore now?", false);
    if (runForReal) {
      await runRestore({ ...config, dryRun: false });
    }
  }
}

let shuttingDown = false;

process.on("SIGINT", () => {
  if (shuttingDown) {
    process.exit(1);
  }
  shuttingDown = true;
  log.blank();
  log.warn("Interrupted - shutting down gracefully...");
  process.exit(0);
});

async function main() {
  if (flags.help) {
    printHelp();
    process.exit(0);
  }

  banner();

  try {
    if (command === "backup") {
      await interactiveBackup();
    } else if (command === "restore") {
      await interactiveRestore();
    } else if (command === "list") {
      const outputDir = args.find((a) => !a.startsWith("-") && a !== "list") || DEFAULT_OUTPUT;
      await printBackupList(outputDir);
    } else {
      const action = await select("What do you want to do?", [
        { label: "Backup a database", value: "backup" },
        { label: "Restore a backup", value: "restore" },
        { label: "List backups", value: "list" },
        { label: "Exit", value: "exit" },
      ]);

      if (action === "backup") await interactiveBackup();
      else if (action === "restore") await interactiveRestore();
      else if (action === "list") {
        const outputDir = await prompt("Backup directory", DEFAULT_OUTPUT);
        await printBackupList(outputDir);
      } else {
        process.exit(0);
      }
    }
  } catch (err: any) {
    log.blank();
    log.error(`Fatal: ${err.message}`);
    if (flags.verbose) console.error(err);
    process.exit(1);
  }
}

main();
