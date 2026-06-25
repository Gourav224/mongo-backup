import type { S3Config } from "../types/index.js";
import { log } from "./logger.js";

function getClient(cfg: S3Config) {
  const opts: Record<string, string> = {
    bucket: cfg.bucket,
    region: cfg.region,
  };
  if (cfg.accessKeyId) opts.accessKeyId = cfg.accessKeyId;
  if (cfg.secretAccessKey) opts.secretAccessKey = cfg.secretAccessKey;
  if (cfg.endpoint) opts.endpoint = cfg.endpoint;

  return new Bun.S3Client(opts);
}

export async function uploadToS3(
  localPath: string,
  cfg: S3Config,
  filename: string
): Promise<string> {
  const key = cfg.prefix ? `${cfg.prefix.replace(/\/$/, "")}/${filename}` : filename;
  log.verbose(`Uploading to s3://${cfg.bucket}/${key}`);

  const client = getClient(cfg);
  const localFile = Bun.file(localPath);
  const s3File = client.file(key);
  const size = localFile.size;

  // Stream directly from local file to S3
  const reader = localFile.stream().getReader();
  const writer = s3File.writer();

  let uploaded = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    await writer.write(value);
    uploaded += value.length;
    log.verbose(`  S3 upload: ${((uploaded / size) * 100).toFixed(0)}%`);
  }

  await writer.end();
  return `s3://${cfg.bucket}/${key}`;
}

export async function downloadFromS3(
  s3Uri: string,
  cfg: S3Config,
  destPath: string
): Promise<void> {
  const withoutProto = s3Uri.replace(/^s3:\/\/[^/]+\//, "");
  log.verbose(`Downloading s3 key: ${withoutProto}`);

  const client = getClient(cfg);
  const s3File = client.file(withoutProto);

  const reader = s3File.stream().getReader();
  const writer = Bun.file(destPath).writer();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    await writer.write(value);
  }

  await writer.end();
}

export async function listS3Backups(cfg: S3Config): Promise<string[]> {
  const client = getClient(cfg);
  const result = await client.list({ prefix: cfg.prefix || "" });
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
