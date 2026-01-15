import { StorageManager } from "../../storage/index.js";
import { ToolContext } from "../../types.js";

export async function handleRegisterSession(args: { projectId: string }, ctx: ToolContext) {
    const manifest = await StorageManager.getProjectManifest(args.projectId);
    if (manifest) {
        ctx.setCurrentProject(args.projectId);
        await StorageManager.addGlobalLog("SYSTEM", `Session Context set to Project: ${args.projectId}`);
        return { content: [{ type: "text", text: `Session context registered for project: ${args.projectId}. All subsequent tools will default to this context.` }] };
    }
    return { content: [{ type: "text", text: `Project '${args.projectId}' not found in registry.` }] };
}
