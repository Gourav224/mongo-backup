import { join } from "path";

export const defaults = {
  uri: Bun.env.MONGODB_URI || Bun.env.MONGO_URI || "",
  outputDir: Bun.env.BACKUP_OUTPUT_DIR || join(process.cwd(), "backups"),
  retentionMax: parseInt(Bun.env.BACKUP_RETENTION_MAX || "10"),
  retentionDays: parseInt(Bun.env.BACKUP_RETENTION_DAYS || "30"),
};
