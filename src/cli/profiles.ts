import kleur from "kleur";
import { log } from "../utils/logger.js";
import { confirm, prompt, select } from "../utils/prompt.js";
import { readJson, writeJson } from "./store.js";

export interface ConnectionProfile {
  name: string;
  uri: string;
  lastUsed: string;
  createdAt: string;
}

export async function listProfiles(): Promise<ConnectionProfile[]> {
  return readJson<ConnectionProfile>("profiles.json");
}

export async function saveProfile(name: string, uri: string): Promise<void> {
  const profiles = await listProfiles();
  const existing = profiles.findIndex((p) => p.name === name);
  const entry: ConnectionProfile = {
    name,
    uri,
    lastUsed: new Date().toISOString(),
    createdAt: existing >= 0 ? profiles[existing]!.createdAt : new Date().toISOString(),
  };

  if (existing >= 0) {
    profiles[existing] = entry;
  } else {
    profiles.push(entry);
  }

  await writeJson("profiles.json", profiles);
}

export async function loadSavedUri(label: string): Promise<string | null> {
  const profiles = await listProfiles();
  if (profiles.length === 0) return null;

  const useSaved = await confirm("Use a saved connection?", false);
  if (!useSaved) return null;

  const options = profiles.map((p) => ({
    label: `${kleur.cyan(p.name)}${p.uri ? kleur.gray(` (${maskUri(p.uri)})`) : ""}`,
    value: p.name,
  }));

  const chosen = await select(`${label} - saved connections`, options);
  const profile = profiles.find((p) => p.name === chosen);
  if (profile) {
    profile.lastUsed = new Date().toISOString();
    await writeJson("profiles.json", profiles);
    return profile.uri;
  }

  return null;
}

export async function offerSaveProfile(uri: string): Promise<void> {
  const save = await confirm("Save this connection for future use?", false);
  if (!save) return;

  const name = await prompt("Connection name");
  if (name) {
    await saveProfile(name, uri);
    log.success(`Saved connection: ${kleur.cyan(name)}`);
  }
}

function maskUri(uri: string): string {
  try {
    const u = new URL(uri);
    if (u.password) u.password = "***";
    if (u.username) u.username = u.username.slice(0, 3) + "***";
    return u.toString();
  } catch {
    return uri.replace(/\/\/[^@]+@/, "//***:***@");
  }
}
