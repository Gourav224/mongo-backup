export interface BackupConfig {
  sourceUri: string;
  sourceDb: string;
  outputDir: string;
  format: "json" | "bson" | "both";
  compress: boolean;
  s3?: S3Config;
  retention?: RetentionConfig;
}

export interface RestoreConfig {
  backupPath: string;
  targetUri: string;
  targetDb: string;
  dryRun: boolean;
  dropExisting: boolean;
  autoBackupBeforeRestore: boolean;
}

export interface S3Config {
  bucket: string;
  region: string;
  prefix: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  endpoint?: string; // for custom S3-compatible
}

export interface RetentionConfig {
  maxBackups: number; // max number of backups to keep
  maxAgeDays: number; // delete backups older than N days
}

export interface BackupManifest {
  version: string;
  createdAt: string;
  sourceUri: string; // sanitized (no password)
  sourceDb: string;
  collections: CollectionMeta[];
  checksums: Record<string, string>; // filename -> sha256
  totalDocuments: number;
  format: "json" | "bson" | "both";
  compressedFile?: string;
  s3Location?: string;
}

export interface CollectionMeta {
  name: string;
  documentCount: number;
  indexes: object[];
  options: object;
  validators?: object;
}

export interface BackupEntry {
  name: string; // folder or .tar.gz name
  path: string; // full path
  manifest: BackupManifest;
  size: number; // bytes
  createdAt: Date;
}

export interface CliOptions {
  verbose?: boolean;
  noColor?: boolean;
}
