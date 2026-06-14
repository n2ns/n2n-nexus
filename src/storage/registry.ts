import { promises as fs } from "node:fs";
import { NexusPaths } from "./paths.js";
import { ProjectManifest } from "../types.js";

export type RegistryData = {
    projects: Record<string, {
        name?: string;
        summary: string;
        lastActive: string;
    }>;
};

const emptyRegistry: RegistryData = { projects: {} };

async function readRegistry(): Promise<RegistryData> {
    try {
        const raw = await fs.readFile(NexusPaths.registryFile, "utf-8");
        const parsed = JSON.parse(raw);
        return sanitizeRegistry(parsed);
    } catch {
        return { ...emptyRegistry };
    }
}

function sanitizeRegistry(data: unknown): RegistryData {
    if (!data || typeof data !== "object") return { ...emptyRegistry };
    const root = data as { projects?: unknown };
    if (!root.projects || typeof root.projects !== "object") return { ...emptyRegistry };

    return {
        projects: Object.fromEntries(
            Object.entries(root.projects as Record<string, unknown>).map(([id, item]) => {
                if (!item || typeof item !== "object") {
                    return [id, {
                        summary: "",
                        lastActive: new Date().toISOString()
                    }];
                }
                const entry = item as { name?: unknown; summary?: unknown; lastActive?: unknown };
                return [id, {
                    name: typeof entry.name === "string" ? entry.name : undefined,
                    summary: typeof entry.summary === "string" ? entry.summary : "",
                    lastActive: typeof entry.lastActive === "string" ? entry.lastActive : new Date().toISOString()
                }];
            })
        )
    };
}

async function writeRegistry(data: RegistryData): Promise<void> {
    await fs.mkdir(NexusPaths.root, { recursive: true });
    await fs.writeFile(NexusPaths.registryFile, JSON.stringify(data, null, 2), "utf-8");
}

async function readProjectManifest(id: string): Promise<Partial<ProjectManifest> | null> {
    try {
        const raw = await fs.readFile(NexusPaths.projectManifestPath(id), "utf-8");
        return JSON.parse(raw) as Partial<ProjectManifest>;
    } catch {
        return null;
    }
}

export class RegistryStorage {
    static async listRegistry(): Promise<RegistryData> {
        return readRegistry();
    }

    static async saveProjectManifest(manifest: ProjectManifest): Promise<void> {
        const projectDir = NexusPaths.projectDir(manifest.id);
        const manifestPath = NexusPaths.projectManifestPath(manifest.id);
        const registry = await readRegistry();
        registry.projects[manifest.id] = {
            name: manifest.name,
            summary: manifest.description || "",
            lastActive: new Date().toISOString()
        };
        await writeRegistry(registry);

        await fs.mkdir(projectDir, { recursive: true });
        await fs.writeFile(
            manifestPath,
            JSON.stringify({ ...manifest, lastUpdated: manifest.lastUpdated || new Date().toISOString() }, null, 2),
            "utf-8"
        );
    }

    static async getProjectManifest(id: string): Promise<ProjectManifest | null> {
        const registry = await readRegistry();
        const entry = registry.projects[id];
        if (!entry) return null;

        const rawManifest = await readProjectManifest(id);
        return {
            id,
            name: entry.name || rawManifest?.name || id,
            description: entry.summary || rawManifest?.description || "",
            techStack: rawManifest?.techStack || [],
            relations: rawManifest?.relations || [],
            lastUpdated: rawManifest?.lastUpdated || entry.lastActive,
            repositoryUrl: rawManifest?.repositoryUrl || "",
            localPath: rawManifest?.localPath || NexusPaths.projectDir(id),
            endpoints: rawManifest?.endpoints || [],
            apiSpec: rawManifest?.apiSpec || [],
            apiDependencies: rawManifest?.apiDependencies,
            gatewayCompatibility: rawManifest?.gatewayCompatibility,
            api_versions: rawManifest?.api_versions,
            feature_tier: rawManifest?.feature_tier
        };
    }

    static async patchProjectManifest(id: string, patch: Partial<ProjectManifest>): Promise<void> {
        const registry = await readRegistry();
        const existing = registry.projects[id];
        if (!existing) throw new Error(`Project '${id}' not found.`);

        registry.projects[id] = {
            ...existing,
            summary: patch.description ?? existing.summary,
            name: patch.name ?? existing.name,
            lastActive: new Date().toISOString()
        };
        await writeRegistry(registry);

        const manifest = await readProjectManifest(id) || {};
        const patchedManifest: ProjectManifest = {
            id,
            name: patch.name ?? manifest.name ?? existing.name ?? "",
            description: patch.description ?? manifest.description ?? "",
            techStack: patch.techStack ?? manifest.techStack ?? [],
            relations: patch.relations ?? manifest.relations ?? [],
            lastUpdated: new Date().toISOString(),
            repositoryUrl: patch.repositoryUrl ?? manifest.repositoryUrl ?? "",
            localPath: patch.localPath ?? manifest.localPath ?? NexusPaths.projectDir(id),
            endpoints: patch.endpoints ?? manifest.endpoints ?? [],
            apiSpec: patch.apiSpec ?? manifest.apiSpec ?? [],
            apiDependencies: patch.apiDependencies ?? manifest.apiDependencies,
            gatewayCompatibility: patch.gatewayCompatibility ?? manifest.gatewayCompatibility,
            api_versions: patch.api_versions ?? manifest.api_versions,
            feature_tier: patch.feature_tier ?? manifest.feature_tier
        };
        await fs.writeFile(
            NexusPaths.projectManifestPath(id),
            JSON.stringify(patchedManifest, null, 2),
            "utf-8"
        );
    }

    static async calculateTopology(projectId?: string) {
        const registry = await readRegistry();
        const projectRecords = await Promise.all(
            Object.entries(registry.projects).map(async ([id, project]) => {
                const manifest = await readProjectManifest(id);
                return {
                    id,
                    name: manifest?.name || project.name || id,
                    summary: project.summary,
                    lastActive: project.lastActive,
                    relations: manifest?.relations || []
                };
            })
        );

        const nodeMap = new Map(projectRecords.map((record) => [record.id, record]));
        const edges = projectRecords.flatMap((project) => {
            return project.relations
                .filter(relation => nodeMap.has(relation.targetId))
                .map((relation) => ({
                    from: project.id,
                    to: relation.targetId,
                    type: relation.type
                }));
        });

        const allProjects = projectRecords.map((project) => ({
            id: project.id,
            name: project.name,
            summary: project.summary,
            lastActive: project.lastActive
        }));

        if (!projectId) {
            return {
                mode: "list" as const,
                summary: {
                    totalProjects: allProjects.length,
                    totalEdges: edges.length
                },
                projects: Object.fromEntries(allProjects.map((project) => [project.id, project]))
            };
        }

        if (!nodeMap.has(projectId)) {
            return {
                mode: "focused" as const,
                nodes: [],
                edges: []
            };
        }

        const visited = new Set<string>();
        const queue = [projectId];
        while (queue.length > 0) {
            const current = queue.shift();
            if (!current || visited.has(current)) {
                continue;
            }
            visited.add(current);
            for (const edge of edges) {
                if (edge.from === current && !visited.has(edge.to)) {
                    queue.push(edge.to);
                }
            }
        }

        return {
            mode: "focused" as const,
            nodes: allProjects.filter((project) => visited.has(project.id)),
            edges: edges.filter((edge) => visited.has(edge.from) && visited.has(edge.to))
        };
    }

    static async deleteProject(projectId: string): Promise<number> {
        const registry = await readRegistry();
        if (!registry.projects[projectId]) return 0;
        delete registry.projects[projectId];
        await writeRegistry(registry);
        return 1;
    }

    static async renameProject(oldId: string, newId: string): Promise<number> {
        const registry = await readRegistry();
        if (!registry.projects[oldId]) return 0;
        if (registry.projects[newId]) {
            throw new Error(`Project '${newId}' already exists.`);
        }

        const entry = registry.projects[oldId];
        delete registry.projects[oldId];
        registry.projects[newId] = entry;
        await writeRegistry(registry);

        for (const projectId of Object.keys(registry.projects)) {
            const manifestId = projectId === newId ? oldId : projectId;
            const manifest = await readProjectManifest(manifestId);
            if (!manifest) continue;

            let changed = false;
            if (projectId === newId && manifest.id !== newId) {
                manifest.id = newId;
                changed = true;
            }

            if (Array.isArray(manifest.relations)) {
                const relations = manifest.relations.map((relation) => {
                    if (relation.targetId !== oldId) return relation;
                    changed = true;
                    return { ...relation, targetId: newId };
                });
                manifest.relations = relations;
            }

            if (changed) {
                await fs.writeFile(
                    NexusPaths.projectManifestPath(manifestId),
                    JSON.stringify(manifest, null, 2),
                    "utf-8"
                );
            }
        }

        return 1;
    }
}
