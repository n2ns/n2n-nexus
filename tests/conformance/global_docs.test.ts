// Global docs and strategy through their tools.
import { describe, expect, it } from "vitest";
import { useHost } from "./harness.js";

const host = useHost();

describe("global docs and strategy", () => {
    it("reads back what sync_global_doc and update_global_strategy wrote", async () => {
        // Each write at its own instant: the list is ordered by when a document was last updated, not by id or creation.
        const t0 = Date.now();
        await host.setClock(t0);
        await host.callTool("sync_global_doc", { docId: "glossary", title: "Glossary", content: "# terms" }, "ide-b");
        await host.setClock(t0 + 1000);
        await host.callTool("sync_global_doc", { docId: "protocol", title: "Sync Protocol", content: "# v1" }, "ide-a");
        await host.callTool("update_global_strategy", { content: "# Strategy" }, "ide-a");

        const docs = async () => (await host.callTool<{ count: number; docs: { docId: string; title: string; updatedBy: string }[] }>("list_global_docs", {})).payload.result;
        expect((await docs())?.count).toBe(2);
        expect((await docs())?.docs).toMatchObject([{ docId: "protocol", title: "Sync Protocol", updatedBy: "ide-a" }, { docId: "glossary", title: "Glossary", updatedBy: "ide-b" }]);
        await host.setClock(t0 + 2000);
        await host.callTool("sync_global_doc", { docId: "glossary", title: "Glossary", content: "# terms" }, "ide-b");
        expect((await docs())?.docs.map((d) => d.docId)).toEqual(["glossary", "protocol"]);
        await host.setClock(null);

        const doc = await host.callTool<{ title: string; content: string }>("get_global_doc", { docId: "protocol" });
        expect(doc.payload.result).toMatchObject({ docId: "protocol", title: "Sync Protocol", content: "# v1", updatedBy: "ide-a" });

        const missing = await host.callTool("get_global_doc", { docId: "nope" });
        expect(missing.status).toBe(400);
        expect(missing.payload.error).toContain("not found");

        const strategy = await host.callTool<{ content: string }>("get_global_strategy", {});
        expect(strategy.payload.result?.content).toBe("# Strategy");
    });
});
