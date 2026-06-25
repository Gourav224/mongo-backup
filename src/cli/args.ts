import kleur from "kleur";
import { banner } from "../utils/logger.js";
import { defaults } from "./env.js";

export interface CliFlags {
  dryRun: boolean;
  verbose: boolean;
  noColor: boolean;
  help: boolean;
}

export type CliCommand = "backup" | "restore" | "list" | undefined;

export function parseArgs(): { flags: CliFlags; command: CliCommand } {
  const args = Bun.argv.slice(2);
  const flags: CliFlags = {
    dryRun: args.includes("--dry-run"),
    verbose: args.includes("--verbose") || args.includes("-v"),
    noColor: args.includes("--no-color"),
    help: args.includes("--help") || args.includes("-h"),
  };

  if (flags.noColor) kleur.enabled = false;

  const command = args.find((a) => !a.startsWith("-")) as CliCommand;

  return { flags, command };
}

export function printHelp() {
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
