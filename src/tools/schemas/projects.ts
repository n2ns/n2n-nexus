import { z } from "zod";
import { ProjectIdSchema, FileNameSchema } from "./base.js";

export const SyncProjectAssetsSchema = z.object({
    manifest: z.object({
        id: ProjectIdSchema,
        name: z.string(),
        description: z.string(),
        techStack: z.array(z.string()),
        relations: z.array(z.object({
            targetId: z.string(),
            type: z.enum(["dependency", "parent", "child", "related"])
        })),
        lastUpdated: z.string().describe("ISO timestamp"),
        repositoryUrl: z.string(),
        localPath: z.string().describe("Physical disk path"),
        endpoints: z.array(z.object({
            name: z.string(),
            url: z.string(),
            description: z.string()
        })),
        apiSpec: z.array(z.object({
            method: z.string(),
            path: z.string(),
            summary: z.string()
        }))
    }),
    internalDocs: z.string().describe("Mandatory technical implementation guide (Markdown)")
});

export const UploadAssetSchema = z.object({
    fileName: FileNameSchema,
    base64Content: z.string()
});

export const UpdateProjectSchema = z.object({
    projectId: ProjectIdSchema,
    patch: z.object({}).passthrough().describe("Fields to update (e.g., description, techStack)")
});

export const RenameProjectSchema = z.object({
    oldId: ProjectIdSchema,
    newId: ProjectIdSchema
});

export const RemoveProjectSchema = z.object({
    projectId: ProjectIdSchema
});

export const SearchProjectsSchema = z.object({
    query: z.string().min(1, "Query is required"),
    limit: z.number().int().positive().optional().default(10)
});
