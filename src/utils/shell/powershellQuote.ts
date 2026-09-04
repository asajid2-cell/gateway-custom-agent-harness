/** PowerShell single-quoted literal: only a single quote needs doubling. */
export function quotePowerShellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}
