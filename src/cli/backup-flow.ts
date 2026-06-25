import { mkdir } from "fs/promises";
import kleur from "kleur";
import { log, section, kv, sanitizeUri } from "../utils/logger.js";
import { prompt, promptPassword, confirm, select } from "../utils/prompt.js";
import { s3ConfigFromEnv } from "../utils/s3.js";
import { runBackup } from "../commands/backup.js";
import { askMongoUri } from "./uri.js";
import { pickDatabase } from "./db-picker.js";
import { defaults } from "./env.js";
import type { S3Config } from "../types/index.js";

export async function interactiveBackup() {
  section("Configure Backup");

  const sourceUri = await askMongoUri("Source MongoDB", defaults.uri);
  const sourceDb = await pickDatabase(sourceUri, "Source");

  const outputDir = await prompt("Backup output directory", defaults.outputDir);
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
      const secretAccessKey = accessKeyId ? await promptPassword("AWS_SECRET_ACCESS_KEY") : "";
      const endpoint = await prompt("Custom S3 endpoint (leave blank for AWS)");
      s3Config = {
        bucket, region, prefix,
        ...(accessKeyId && { accessKeyId }),
        ...(secretAccessKey && { secretAccessKey }),
        ...(endpoint && { endpoint }),
      };
    }
  }

  const wantRetention = await confirm("Enable retention policy?", true);
  const retention = wantRetention
    ? {
        maxBackups: parseInt(await prompt("Max backups to keep", String(defaults.retentionMax))),
        maxAgeDays: parseInt(await prompt("Delete backups older than (days)", String(defaults.retentionDays))),
      }
    : undefined;

  section("Summary");
  kv("Source", sanitizeUri(sourceUri));
  kv("Database", sourceDb);
  kv("Format", format);
  kv("Output", outputDir);
  kv("S3 upload", s3Config ? `s3://${s3Config.bucket}/${s3Config.prefix}` : "No");
  kv("Retention", retention ? `max ${retention.maxBackups} backups, ${retention.maxAgeDays} days` : "Disabled");
  log.blank();

  const ok = await confirm("Proceed with backup?", true);
  if (!ok) {
    log.warn("Backup cancelled.");
    process.exit(0);
  }

  await runBackup({
    sourceUri,
    sourceDb,
    outputDir,
    format: format as "json" | "bson" | "both",
    compress: true,
    s3: s3Config,
    retention,
  });
}
