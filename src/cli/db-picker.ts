import { MongoClient } from "mongodb";
import kleur from "kleur";
import { log, Spinner } from "../utils/logger.js";
import { prompt, select } from "../utils/prompt.js";
import { isValidDbName } from "./validate.js";

export interface DbInfo {
  name: string;
  sizeOnDisk?: number;
  empty: boolean;
}

function formatBytes(bytes?: number): string {
  if (!bytes) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

async function listDatabases(uri: string): Promise<DbInfo[]> {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000 });
  try {
    await client.connect();
    const admin = client.db().admin();
    const result = await admin.listDatabases();
    return result.databases
      .filter((d) => !["admin", "local", "config"].includes(d.name))
      .map((d) => ({
        name: d.name,
        sizeOnDisk: d.sizeOnDisk,
        empty: d.empty ?? true,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } finally {
    await client.close().catch(() => {});
  }
}

export async function typeDbName(label: string): Promise<string> {
  let name = await prompt(`${label} database name`);
  while (!name || !isValidDbName(name)) {
    if (!name) log.warn("Database name is required");
    else log.warn(`Invalid name: "${name}" (max 63 chars, no spaces/special chars)`);
    name = await prompt(`${label} database name`);
  }
  return name;
}

export async function pickDatabase(uri: string, label: string): Promise<string> {
  const pickMode = await select(`${label} - how to choose?`, [
    { label: "List databases on this server", value: "list", hint: "connect and pick" },
    { label: "Type database name", value: "type", hint: "enter manually" },
  ]);

  if (pickMode === "type") return await typeDbName(label);

  const listSpinner = new Spinner("Connecting to list databases...").start();
  try {
    const dbs = await listDatabases(uri);
    listSpinner.stop();

    if (dbs.length === 0) {
      log.warn("No user databases found on this server");
      return await typeDbName(label);
    }

    const options = dbs.map((db) => ({
      label: db.name + (db.sizeOnDisk ? kleur.gray(` (${formatBytes(db.sizeOnDisk)})`) : ""),
      value: db.name,
      hint: db.empty ? "empty" : undefined,
    }));

    return await select(`${label} - select database`, options);
  } catch (err: any) {
    listSpinner.fail(`Could not list databases: ${err.message}`);
    log.warn("Falling back to manual input");
    return await typeDbName(label);
  }
}
