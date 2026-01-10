/**
 * CLI Argument Parsing
 */

const args = process.argv.slice(2);

export function getArg(k: string): string {
    const i = args.indexOf(k);
    return i !== -1 && args[i + 1] ? args[i + 1] : "";
}

export function hasFlag(k: string): boolean {
    return args.includes(k) || args.includes(k.charAt(1) === "-" ? k : k.substring(0, 2));
}
