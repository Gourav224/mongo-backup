#!/usr/bin/env bun
import kleur from "kleur";
import { banner, log } from "./utils/logger.js";
import { prompt, select } from "./utils/prompt.js";
import { parseArgs, printHelp } from "./cli/args.js";
import { interactiveBackup } from "./cli/backup-flow.js";
import { interactiveRestore } from "./cli/restore-flow.js";
import { printBackupList } from "./commands/list.js";
import { getCurrentBackupDir, resetCurrentBackupDir } from "./commands/backup.js";
import { defaults } from "./cli/env.js";

const { flags, command } = parseArgs();

let shuttingDown = false;

process.on("SIGINT", () => {
  if (shuttingDown) process.exit(1);
  shuttingDown = true;
  log.blank();
  log.warn("Interrupted - shutting down gracefully...");
  const partialDir = getCurrentBackupDir();
  if (partialDir) {
    log.dim(`  Cleaning up partial backup: ${partialDir}`);
    Bun.$`rm -rf ${partialDir}`.quiet().catch(() => {});
    resetCurrentBackupDir();
  }
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
      await interactiveRestore(flags.dryRun);
    } else if (command === "list") {
      const args = Bun.argv.slice(2);
      const outputDir = args.find((a) => !a.startsWith("-") && a !== "list") || defaults.outputDir;
      await printBackupList(outputDir);
    } else {
      const action = await select("What do you want to do?", [
        { label: "Backup a database", value: "backup" },
        { label: "Restore a backup", value: "restore" },
        { label: "List backups", value: "list" },
        { label: "Exit", value: "exit" },
      ]);

      if (action === "backup") await interactiveBackup();
      else if (action === "restore") await interactiveRestore(flags.dryRun);
      else if (action === "list") {
        const outputDir = await prompt("Backup directory", defaults.outputDir);
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
