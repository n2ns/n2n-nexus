import { z } from "zod";

/**
 * Project ID validation regex based on Nexus conventions.
 */
export const ProjectIdSchema = z.string()
    .describe("Strict flat identifier. MUST start with a type-prefix followed by an underscore.")
    .refine(val => {
        const validPrefixes = ["web_", "api_", "chrome_", "vscode_", "mcp_", "android_", "ios_", "flutter_", "desktop_", "lib_", "bot_", "infra_", "doc_"];
        return validPrefixes.some(p => val.startsWith(p));
    }, "Project ID must start with a valid prefix (e.g., 'web_', 'api_')")
    .refine(val => !val.includes("..") && !val.includes("/") && !val.includes("\\"), "Project ID cannot contain '..' or slashes.");

/**
 * File Name validation to prevent path traversal.
 */
export const FileNameSchema = z.string()
    .min(1, "File name cannot be empty")
    .max(255, "File name too long")
    .refine(val => !val.includes("/") && !val.includes("\\"), "File name cannot contain path separators")
    .refine(val => !val.includes(".."), "File name cannot contain '..'")
    .refine(val => !val.startsWith("."), "File name cannot start with '.'")
    .describe("Safe file name without path components");

export const EmptySchema = z.object({});
