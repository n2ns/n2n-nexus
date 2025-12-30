import path from "path";
import { fileURLToPath } from "url";
import { HubConfig } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

const getArg = (k: string) => {
    const i = args.indexOf(k);
    return i !== -1 && args[i + 1] ? args[i + 1] : "";
};

const hasFlag = (k: string) => args.includes(k);

export const CONFIG: HubConfig = {
    instanceId: getArg("--id") || "Assistant",
    isModerator: hasFlag("--moderator"),
    rootStorage: path.resolve(getArg("--root") || path.join(__dirname, "../storage"))
};
