import kleur from "kleur";

let _verbose = false;
let _noColor = false;

export function setVerbose(v: boolean) { _verbose = v; }
export function setNoColor(v: boolean) {
  _noColor = v;
  if (v) kleur.enabled = false;
}

// ─── Spinner ─────────────────────────────────────────────────────────────────

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class Spinner {
  private frame = 0;
  private interval: ReturnType<typeof setInterval> | null = null;
  private text: string;

  constructor(text: string) {
    this.text = text;
  }

  start() {
    process.stdout.write("\x1B[?25l"); // hide cursor
    this.interval = setInterval(() => {
      process.stdout.write(
        `\r${kleur.cyan(SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length])} ${this.text}   `
      );
      this.frame++;
    }, 80);
    return this;
  }

  update(text: string) {
    this.text = text;
  }

  succeed(msg: string) {
    this.stop();
    process.stdout.write(`\r${kleur.green("✔")} ${msg}\n`);
  }

  fail(msg: string) {
    this.stop();
    process.stdout.write(`\r${kleur.red("✖")} ${msg}\n`);
  }

  warn(msg: string) {
    this.stop();
    process.stdout.write(`\r${kleur.yellow("⚠")} ${msg}\n`);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    process.stdout.write("\x1B[?25h"); // show cursor
    process.stdout.write("\r\x1B[K");
  }
}

// ─── Log helpers ─────────────────────────────────────────────────────────────

export const log = {
  info: (msg: string) => console.log(`  ${kleur.blue("ℹ")} ${msg}`),
  success: (msg: string) => console.log(`  ${kleur.green("✔")} ${msg}`),
  warn: (msg: string) => console.log(`  ${kleur.yellow("⚠")} ${kleur.yellow(msg)}`),
  error: (msg: string) => console.error(`  ${kleur.red("✖")} ${kleur.red(msg)}`),
  verbose: (msg: string) => { if (_verbose) console.log(`  ${kleur.gray("›")} ${kleur.gray(msg)}`); },
  dim: (msg: string) => console.log(`  ${kleur.gray(msg)}`),
  blank: () => console.log(),
  divider: () => console.log(kleur.gray("  " + "─".repeat(60))),
};

export function banner() {
  console.log();
  console.log(kleur.bold().cyan("  ╔════════════════════════════════════════╗"));
  console.log(kleur.bold().cyan("  ║") + kleur.bold("     🍃 MongoDB Backup CLI  v1.0.0      ") + kleur.bold().cyan("║"));
  console.log(kleur.bold().cyan("  ╚════════════════════════════════════════╝"));
  console.log();
}

export function section(title: string) {
  console.log();
  console.log(`  ${kleur.bold().white(title)}`);
  console.log(`  ${kleur.gray("─".repeat(title.length + 2))}`);
}

export function kv(key: string, value: string, indent = 4) {
  const pad = " ".repeat(indent);
  console.log(`${pad}${kleur.gray(key.padEnd(22))} ${kleur.white(value)}`);
}

export function sanitizeUri(uri: string): string {
  try {
    const u = new URL(uri);
    if (u.password) u.password = "***";
    if (u.username) u.username = u.username.substring(0, 3) + "***";
    return u.toString();
  } catch {
    return uri.replace(/:\/\/[^@]+@/, "://***:***@");
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  const s = ((ms % 60000) / 1000).toFixed(0);
  return `${m}m ${s}s`;
}
