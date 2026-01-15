import { StorageManager } from "../storage/index.js";
import { getResourceContent } from "../resources/index.js";
import { sanitizeErrorMessage } from "../utils/error.js";

export class ResourceHandler {
    static async read(uri: string, currentProject: string | null) {
        try {
            const result = await getResourceContent(uri, currentProject);
            if (!result) {
                throw new Error(`Resource not found: ${uri}`);
            }
            return { contents: [{ uri, ...result }] };
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            throw new Error(`Nexus Read Error: ${sanitizeErrorMessage(msg)}`);
        }
    }
}
