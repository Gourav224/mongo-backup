import { existsSync } from "fs";
import kleur from "kleur";
import { log, section, kv, sanitizeUri } from "../utils/logger.js";
import { prompt, promptPassword, confirm, select } from "../utils/prompt.js";
import { runRestore } from "../commands/restore.js";
import { listBackups, printBackupList } from "../commands/list.js";
import { askMongoUri } from "./uri.js";
import { pickDatabase, typeDbName } from "./db-picker.js";
import { isValidPort } from "./validate.js";
import { defaults } from "./env.js";
import type { RestoreConfig } from "../types/index.js";

export async function interactiveRestore(dryRunFlag: boolean) {
  section("Configure Restore");

  const outputDir = await prompt("Backup directory", defaults.outputDir);
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
      label: "Same cluster - different DB name",
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
    targetUri = await askMongoUri("Same cluster URI", defaults.uri);

    const sourceDb = entries.find((e) => e.path === backupPath)?.manifest.sourceDb || "db";
    const useExisting = await confirm("Restore into an existing database on this cluster?", false);
    if (useExisting) {
      targetDb = await pickDatabase(targetUri, "Target");
      log.warn(`Restoring into existing database: ${kleur.cyan(targetDb)}`);
    } else {
      targetDb = await prompt("New database name", `${sourceDb}_restore`);
    }
  } else if (targetType === "different-atlas") {
    targetUri = await askMongoUri("Target Atlas URI");
    targetDb = await pickDatabase(targetUri, "Target");
  } else if (targetType === "local") {
    const host = await prompt("Host", "localhost");
    let port = await prompt("Port", "27017");
    while (port && !isValidPort(port)) {
      log.warn(`Invalid port: "${port}" - must be 1-65535`);
      port = await prompt("Port", "27017");
    }
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
    targetDb = await typeDbName("Target");
  }

  const dropExisting = await confirm(
    `Drop existing collections in "${targetDb}" before restore?`,
    false,
  );
  const autoBackupBeforeRestore = await confirm(
    "Auto-backup target DB before restoring (safety net)?",
    true,
  );
  const dryRun = dryRunFlag || (await confirm("Do a dry run first (preview only)?", true));

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
    backupPath, targetUri, targetDb, dryRun, dropExisting, autoBackupBeforeRestore,
  };

  await runRestore(config);

  if (dryRun) {
    const runForReal = await confirm("Dry run complete. Run the actual restore now?", false);
    if (runForReal) {
      await runRestore({ ...config, dryRun: false });
    }
  }
}
