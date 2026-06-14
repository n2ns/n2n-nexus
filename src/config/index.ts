import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgPath = path.resolve(__dirname, "../../package.json");
export const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { name: string; version: string };

export function getRootPath(): string {
    // Priority: --root CLI arg → NEXUS_ROOT env → ~/.n2n-nexus
    const argIndex = process.argv.indexOf("--root");
    if (argIndex !== -1 && process.argv[argIndex + 1]) {
        return process.argv[argIndex + 1];
    }
    if (process.env.NEXUS_ROOT) return process.env.NEXUS_ROOT;
    return path.join(process.env.HOME || process.env.USERPROFILE || ".", ".n2n-nexus");
}
