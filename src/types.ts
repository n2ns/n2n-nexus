export interface ProjectManifest {
    id: string;
    name: string;
    description: string;
    techStack: string[];
    relations: { targetId: string; type: "dependency" | "parent" | "child" | "related" }[];
    billing?: { plain: string; price: string };
    lastUpdated: string;
    repositoryUrl: string;
    localPath: string; // Physical disk path of the project (required)
    endpoints: { name: string; url: string; description: string }[];
    apiSpec: { method: string; path: string; summary: string }[];
}

export interface DiscussionMessage {
    timestamp: string;
    from: string;
    text: string;
}

export interface HubConfig {
    instanceId: string;
    moderatorId: string;
    rootStorage: string;
}

export interface Registry {
    projects: Record<string, {
        name?: string;
        summary: string;
        lastActive: string;
    }>;
}

export interface GlobalDocEntry {
    title: string;
    lastUpdated: string;
    updatedBy: string;
}

export type GlobalDocIndex = Record<string, GlobalDocEntry>;
