import Database from "better-sqlite3";
import path from "path";
import { CONFIG } from "../config.js";

let db: Database.Database | null = null;

/**
 * SQLite Database Schema for Nexus Meetings
 */
const SCHEMA = `
-- Meetings table
CREATE TABLE IF NOT EXISTS meetings (
    id TEXT PRIMARY KEY,
    topic TEXT NOT NULL,
    status TEXT CHECK(status IN ('active', 'closed', 'archived')) DEFAULT 'active',
    initiator TEXT,
    participants TEXT DEFAULT '[]',
    created_at TEXT NOT NULL,
    closed_at TEXT,
    summary TEXT
);

-- Messages table
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id TEXT NOT NULL,
    sender TEXT NOT NULL,
    text TEXT NOT NULL,
    category TEXT CHECK(category IN ('MEETING_START', 'PROPOSAL', 'DECISION', 'UPDATE', 'CHAT')),
    timestamp TEXT NOT NULL,
    FOREIGN KEY (meeting_id) REFERENCES meetings(id)
);

-- Decisions table (extracted from DECISION messages)
CREATE TABLE IF NOT EXISTS decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    FOREIGN KEY (meeting_id) REFERENCES meetings(id)
);

-- Meeting state (Key-Value store)
CREATE TABLE IF NOT EXISTS meeting_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_messages_meeting ON messages(meeting_id);
CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
CREATE INDEX IF NOT EXISTS idx_decisions_meeting ON decisions(meeting_id);
CREATE INDEX IF NOT EXISTS idx_meetings_status ON meetings(status);
`;

/**
 * Get the database file path
 */
export function getDbPath(): string {
    return path.join(CONFIG.rootStorage, "nexus.db");
}

/**
 * Initialize the SQLite database with WAL mode
 */
export function initDatabase(): Database.Database {
    if (db) return db;

    const dbPath = getDbPath();
    db = new Database(dbPath);
    
    // Enable WAL mode for better concurrent access
    db.pragma("journal_mode = WAL");
    
    // Initialize schema
    db.exec(SCHEMA);
    
    // Migration: Add initiator column if it doesn't exist (Upgrade from v0.1.7)
    try {
        const columns = db.prepare("PRAGMA table_info(meetings)").all() as any[];
        const hasInitiator = columns.some(c => c.name === "initiator");
        if (!hasInitiator) {
            console.error("[Nexus] Migrating database: Adding 'initiator' column to 'meetings' table.");
            db.exec("ALTER TABLE meetings ADD COLUMN initiator TEXT");
        }
    } catch (e) {
        console.error("[Nexus] Migration check failed:", e);
    }
    
    // Initialize default state if not exists
    const stmt = db.prepare("INSERT OR IGNORE INTO meeting_state (key, value) VALUES (?, ?)");
    stmt.run("active_meetings", "[]");
    stmt.run("default_meeting", "");
    
    console.error("[Nexus] SQLite database initialized at:", dbPath);
    
    return db;
}

/**
 * Get the database instance
 */
export function getDatabase(): Database.Database {
    if (!db) {
        return initDatabase();
    }
    return db;
}

/**
 * Close the database connection
 */
export function closeDatabase(): void {
    if (db) {
        db.close();
        db = null;
        console.error("[Nexus] SQLite database closed");
    }
}

/**
 * Check if SQLite is available
 */
export function isSqliteAvailable(): boolean {
    try {
        // Try to load better-sqlite3
        require("better-sqlite3");
        return true;
    } catch {
        return false;
    }
}

// Cleanup on process exit
process.on("exit", () => {
    closeDatabase();
});

process.on("SIGINT", () => {
    closeDatabase();
    process.exit(0);
});

process.on("SIGTERM", () => {
    closeDatabase();
    process.exit(0);
});
