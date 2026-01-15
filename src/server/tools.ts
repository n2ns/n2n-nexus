import { StorageManager } from "../storage/index.js";
import { handleToolCall } from "../tools/index.js";
import { authorizeToolCall, getRequestOrigin, RequestOrigin } from "../auth/index.js";
import { sanitizeErrorMessage } from "../utils/error.js";

export interface ToolExecutionResult {
    content: { type: string; text: string }[];
    isError?: boolean;
}

export class ToolDispatcher {
    /**
     * Executes a tool call with full authorization and context management.
     */
    static async execute(
        name: string,
        args: Record<string, unknown> | undefined,
        requestId: string | number | undefined,
        extra: any,
        context: {
            currentProject: string | null;
            setCurrentProject: (id: string) => void;
        },
        originOverride?: RequestOrigin
    ): Promise<ToolExecutionResult> {
        try {
            const origin = originOverride || getRequestOrigin(extra);

            // 1. Session-level tools (Internal to Server state)
            if (name === "switch_project") {
                const projectId = (args as any)?.project_id;
                if (projectId) {
                    const manifest = await StorageManager.getProjectManifest(projectId);
                    if (manifest) {
                        context.setCurrentProject(projectId);
                        return { content: [{ type: "text", text: `Switched to project: ${projectId}` }] };
                    }
                }
                return { content: [{ type: "text", text: `Project '${projectId}' not found.` }] };
            }

            // 2. Authorization
            try {
                authorizeToolCall(name, origin);
            } catch (err: any) {
                return { content: [{ type: "text", text: `[Permission Denied] ${err.message}` }] };
            }

            // 3. Execution
            const isGuest = origin === RequestOrigin.REMOTE_GUEST;
            const toolCtx = {
                currentProject: context.currentProject,
                setCurrentProject: context.setCurrentProject,
                notifyResourceUpdate: (_uri: string) => { /* Broadcast logic can be injected here */ },
                requestId,
                isGuest
            };

            return await handleToolCall(name, args || {}, toolCtx);

        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            const idPrefix = requestId ? `[Req:${requestId}] ` : "";
            return {
                content: [{ type: "text", text: sanitizeErrorMessage(`${idPrefix}Tool Error: ${msg}`) }],
                isError: true
            };
        }
    }
}
