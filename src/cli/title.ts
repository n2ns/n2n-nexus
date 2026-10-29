/**
 * The conversation's title as its client shows it, which the hook command adds
 * to the input it forwards as `title`. Neither source is documented, so every
 * failure (missing file, unexpected format, locked database, time budget
 * spent) yields undefined and the hook goes on without a title.
 *
 * Claude Code: the transcript (`transcript_path`, JSONL, can be very large)
 * gets `{"type":"custom-title","customTitle":…}` records when the user renames
 * the conversation and `{"type":"ai-title","aiTitle":…}` records for the
 * automatic title, appended again and again; only its last and, failing that,
 * first TRANSCRIPT_CHUNK_BYTES are read. Codex: `threads.name` (set by the
 * user) or else `threads.title` in the newest `$CODEX_HOME/state_<N>.sqlite`.
 */
import { open, readdir } from "node:fs/promises";
import path from "node:path";

import { MAX_TITLE_CHARS, type HookClient } from "../contract.js";
import { codexHome } from "./client-dirs.js";

/** How much of the transcript's end, and then of its start, is searched for a title. */
const TRANSCRIPT_CHUNK_BYTES = 256 * 1024;
/** Reading the title may not hold up the hook for longer than this. */
const TITLE_BUDGET_MS = 50;

/** Trimmed first line, at most MAX_TITLE_CHARS characters; undefined when nothing is left. */
function cleanTitle(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const line = value.trim().split(/\r\n|\r|\n/)[0].trim();
    const chars = Array.from(line);
    const title = chars.length > MAX_TITLE_CHARS ? chars.slice(0, MAX_TITLE_CHARS).join("").trimEnd() : line;
    return title || undefined;
}

/** The last custom title in `text`, or else the last automatic one. */
function titleInJsonl(text: string): string | undefined {
    let custom: string | undefined;
    let ai: string | undefined;
    for (const line of text.split("\n")) {
        if (!line.includes("-title")) continue;
        let record: unknown;
        try {
            record = JSON.parse(line);
        } catch {
            continue;                       // the chunk's cut-off first or last line
        }
        if (typeof record !== "object" || record === null) continue;
        const { type, customTitle, aiTitle } = record as Record<string, unknown>;
        if (type === "custom-title") custom = cleanTitle(customTitle) ?? custom;
        else if (type === "ai-title") ai = cleanTitle(aiTitle) ?? ai;
    }
    return custom ?? ai;
}

async function claudeTitle(transcriptPath: unknown): Promise<string | undefined> {
    if (typeof transcriptPath !== "string" || !transcriptPath) return undefined;
    const file = await open(transcriptPath, "r");
    try {
        const { size } = await file.stat();
        const read = async (position: number, length: number) => {
            const buffer = Buffer.alloc(length);
            const { bytesRead } = await file.read(buffer, 0, length, position);
            return buffer.toString("utf8", 0, bytesRead);
        };
        const tailStart = Math.max(0, size - TRANSCRIPT_CHUNK_BYTES);
        const title = titleInJsonl(await read(tailStart, size - tailStart));
        if (title !== undefined || tailStart === 0) return title;
        return titleInJsonl(await read(0, TRANSCRIPT_CHUNK_BYTES));
    } finally {
        await file.close();
    }
}

/** node:sqlite without the ExperimentalWarning older Node versions print on stderr when it loads. */
async function loadSqlite(): Promise<typeof import("node:sqlite")> {
    const emitWarning = process.emitWarning;
    process.emitWarning = function (warning: string | Error, ...args: unknown[]) {
        const type = typeof args[0] === "string" ? args[0] : (args[0] as { type?: string } | undefined)?.type ?? (warning instanceof Error ? warning.name : undefined);
        const message = warning instanceof Error ? warning.message : String(warning);
        if (type === "ExperimentalWarning" && message.includes("SQLite")) return;
        return (emitWarning as (...a: unknown[]) => void).call(process, warning, ...args);
    } as typeof process.emitWarning;
    try {
        return await import("node:sqlite");
    } finally {
        process.emitWarning = emitWarning;
    }
}

async function codexTitle(sessionId: unknown): Promise<string | undefined> {
    if (typeof sessionId !== "string" || !sessionId) return undefined;
    const home = codexHome();
    let newest: { n: number; name: string } | undefined;
    for (const name of await readdir(home)) {
        const match = /^state_(\d+)\.sqlite$/.exec(name);
        if (match && (newest === undefined || Number(match[1]) > newest.n)) newest = { n: Number(match[1]), name };
    }
    if (!newest) return undefined;
    const { DatabaseSync } = await loadSqlite();
    const db = new DatabaseSync(path.join(home, newest.name), { readOnly: true });
    try {
        const row = db.prepare("SELECT name, title FROM threads WHERE id = ?").get(sessionId) as { name?: unknown; title?: unknown } | undefined;
        return row ? cleanTitle(row.name) ?? cleanTitle(row.title) : undefined;
    } finally {
        db.close();
    }
}

/** The title of the conversation `input` (the hook's stdin) belongs to, or undefined; never throws. */
export async function readTitle(client: HookClient, input: Record<string, unknown>): Promise<string | undefined> {
    let timer: NodeJS.Timeout | undefined;
    const budget = new Promise<undefined>((resolve) => { timer = setTimeout(resolve, TITLE_BUDGET_MS, undefined); });
    const read = client === "claude" ? claudeTitle(input.transcript_path) : codexTitle(input.session_id);
    try {
        return await Promise.race([read.catch(() => undefined), budget]);
    } finally {
        clearTimeout(timer);
    }
}
