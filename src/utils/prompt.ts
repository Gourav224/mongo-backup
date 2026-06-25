import kleur from "kleur";

function readLineRaw(promptText: string, hidden = false): Promise<string> {
  return new Promise((resolve) => {
    Bun.stdout.write(promptText);
    let input = "";
    const onData = (chunk: Buffer) => {
      const str = chunk.toString();
      for (const ch of str) {
        if (ch === "\n" || ch === "\r") {
          process.stdin.removeListener("data", onData);
          process.stdin.pause();
          Bun.stdout.write("\n");
          resolve(input.trim());
          return;
        } else if (ch === "\x7f" || ch === "\b") {
          if (input.length > 0) {
            input = input.slice(0, -1);
            if (!hidden) Bun.stdout.write("\b \b");
          }
        } else if (ch === "\x03") {
          process.exit(1);
        } else {
          input += ch;
          Bun.stdout.write(hidden ? "*" : ch);
        }
      }
    };
    process.stdin.resume();
    process.stdin.setRawMode?.(true);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", onData);
  });
}

export async function prompt(question: string, defaultValue?: string): Promise<string> {
  const def = defaultValue ? kleur.gray(` (${defaultValue})`) : "";
  const answer = await readLineRaw(`  ${kleur.cyan("?")} ${kleur.bold(question)}${def}: `);
  return answer || defaultValue || "";
}

export async function promptPassword(question: string): Promise<string> {
  return readLineRaw(`  ${kleur.cyan("?")} ${kleur.bold(question)}: `, true);
}

export async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? kleur.gray("Y/n") : kleur.gray("y/N");
  const answer = await readLineRaw(`  ${kleur.yellow("?")} ${kleur.bold(question)} ${hint}: `);
  if (!answer) return defaultYes;
  return answer.toLowerCase().startsWith("y");
}

export async function select<T extends string>(
  question: string,
  options: { label: string; value: T; hint?: string }[]
): Promise<T> {
  console.log(`\n  ${kleur.cyan("?")} ${kleur.bold(question)}\n`);
  options.forEach((o, i) => {
    const num = kleur.cyan(`    ${(i + 1).toString().padStart(2)}.`);
    const hint = o.hint ? kleur.gray(` -- ${o.hint}`) : "";
    console.log(`${num} ${o.label}${hint}`);
  });
  console.log();

  while (true) {
    const raw = await readLineRaw(`  ${kleur.gray(`Enter number [1-${options.length}]`)}: `);
    const idx = parseInt(raw) - 1;
    if (idx >= 0 && idx < options.length) {
      const chosen = options[idx]!;
      console.log(`     ${kleur.green(">")} ${kleur.bold(chosen.label)}`);
      return chosen.value;
    }
    Bun.stdout.write(`  ${kleur.red("Invalid choice, try again")}\n`);
  }
}

export async function multiSelect<T extends string>(
  question: string,
  options: { label: string; value: T; hint?: string }[]
): Promise<T[]> {
  console.log(`\n  ${kleur.cyan("?")} ${kleur.bold(question)}`);
  console.log(kleur.gray("  Enter comma-separated numbers (e.g. 1,3)\n"));
  options.forEach((o, i) => {
    const num = kleur.cyan(`    ${(i + 1).toString().padStart(2)}.`);
    const hint = o.hint ? kleur.gray(` -- ${o.hint}`) : "";
    console.log(`${num} ${o.label}${hint}`);
  });
  console.log();

  while (true) {
    const raw = await readLineRaw(`  ${kleur.gray("Enter numbers")}: `);
    const parts = raw.split(",").map((s) => parseInt(s.trim()) - 1);
    if (parts.every((i) => i >= 0 && i < options.length)) {
      const selected = parts.map((i) => options[i]!);
      console.log(`     ${kleur.green(">")} ${selected.map((s) => s.label).join(", ")}`);
      return selected.map((s) => s.value);
    }
    Bun.stdout.write(`  ${kleur.red("Invalid selection, try again")}\n`);
  }
}
