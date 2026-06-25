import type { S3Config } from "../types/index.js";
import { log } from "./logger.js";

// ─── Bun native S3 ───────────────────────────────────────────────────────────
// Bun.S3Client is available in Bun >= 1.1.0

function getClient(cfg: S3Config) {
  const opts: Record<string, string> = {
    bucket: cfg.bucket,
    region: cfg.region,
  };
  if (cfg.accessKeyId) opts.accessKeyId = cfg.accessKeyId;
  if (cfg.secretAccessKey) opts.secretAccessKey = cfg.secretAccessKey;
  if (cfg.endpoint) opts.endpoint = cfg.endpoint;

  // @ts-ignore — Bun global
  return new Bun.S3Client(opts);
}

export async function uploadToS3(
  localFile: string,
  cfg: S3Config,
  filename: string
): Promise<string> {
  const key = cfg.prefix ? `${cfg.prefix.replace(/\/$/, "")}/${filename}` : filename;
  log.verbose(`Uploading to s3://${cfg.bucket}/${key}`);

  const client = getClient(cfg);
  const file = Bun.file(localFile);
  const s3File = client.file(key);

  await s3File.write(file);

  return `s3://${cfg.bucket}/${key}`;
}

export async function downloadFromS3(
  s3Uri: string,
  cfg: S3Config,
  destPath: string
): Promise<void> {
  // parse key from s3://bucket/key
  const withoutProto = s3Uri.replace(/^s3:\/\/[^/]+\//, "");
  log.verbose(`Downloading s3 key: ${withoutProto}`);

  const client = getClient(cfg);
  const s3File = client.file(withoutProto);
  const content = await s3File.arrayBuffer();

  await Bun.write(destPath, content);
}

export async function listS3Backups(cfg: S3Config): Promise<string[]> {
  const client = getClient(cfg);
  // @ts-ignore
  const result = await client.list({ prefix: cfg.prefix || "" });
  // @ts-ignore
  return (result.contents || []).map((o) => o.key as string);
}

export async function deleteFromS3(key: string, cfg: S3Config): Promise<void> {
  const client = getClient(cfg);
  const s3File = client.file(key);
  await s3File.delete();
}

export function s3ConfigFromEnv(): S3Config | null {
  const bucket = process.env.BACKUP_S3_BUCKET;
  const region = process.env.BACKUP_S3_REGION || "us-east-1";
  const prefix = process.env.BACKUP_S3_PREFIX || "mongo-backups";
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const endpoint = process.env.BACKUP_S3_ENDPOINT;

  if (!bucket) return null;

  return { bucket, region, prefix, accessKeyId, secretAccessKey, endpoint };
}
