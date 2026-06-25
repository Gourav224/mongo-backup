export function isValidPort(s: string): boolean {
  const n = parseInt(s);
  return !isNaN(n) && n > 0 && n <= 65535;
}

export function isValidDbName(s: string): boolean {
  return s.length > 0
    && s.length <= 63
    && !s.includes("/")
    && !s.includes("\\")
    && !s.includes(" ")
    && !s.includes("$");
}
