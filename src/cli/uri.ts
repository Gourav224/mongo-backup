import kleur from "kleur";
import { log } from "../utils/logger.js";
import { prompt, promptPassword, confirm, select } from "../utils/prompt.js";
import { sanitizeUri } from "../utils/logger.js";
import { isValidPort } from "./validate.js";
import { loadSavedUri, offerSaveProfile } from "./profiles.js";

export async function askMongoUri(label: string, defaultUri?: string): Promise<string> {
  if (defaultUri) {
    log.info(`Using ${label} from environment: ${kleur.cyan(sanitizeUri(defaultUri))}`);
    const useDefault = await confirm("Use this connection string?", true);
    if (useDefault) return defaultUri;
  }

  const saved = await loadSavedUri(label);
  if (saved) return saved;

  const type = await select(`${label} - connection type`, [
    { label: "MongoDB Atlas (connection string)", value: "atlas", hint: "mongodb+srv://..." },
    { label: "Local MongoDB", value: "local", hint: "mongodb://localhost:27017" },
    { label: "Custom URI", value: "custom", hint: "full connection string" },
  ]);

  let uri: string;

  if (type === "local") {
    const host = await prompt("Host", "localhost");
    let port = await prompt("Port", "27017");
    while (port && !isValidPort(port)) {
      log.warn(`Invalid port: "${port}" - must be 1-65535`);
      port = await prompt("Port", "27017");
    }
    const useAuth = await confirm("Does it require authentication?", false);
    if (useAuth) {
      const user = await prompt("Username");
      const pass = await promptPassword("Password");
      uri = `mongodb://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
    } else {
      uri = `mongodb://${host}:${port}`;
    }
  } else if (type === "atlas") {
    log.dim("  Format: mongodb+srv://<user>:<password>@<cluster>.mongodb.net");
    uri = await prompt("Atlas connection string");
  } else {
    uri = await prompt("Full MongoDB URI");
  }

  await offerSaveProfile(uri);
  return uri;
}
