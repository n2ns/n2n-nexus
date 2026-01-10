/**
 * Nexus Network Constants
 * 
 * Centralized configuration for network-related settings.
 */

// Service identification
export const SERVICE_NAME = "n2n-nexus";

// Host address for binding and connecting
// Use "0.0.0.0" to allow connections from any interface
// Use "127.0.0.1" to restrict to localhost only
export const NEXUS_HOST = "0.0.0.0";

// Port range for auto-election
export const PORT_RANGE_START = 5688;
export const PORT_RANGE_END = 5800;

// Timeouts (milliseconds)
export const HANDSHAKE_TIMEOUT = 500;
export const HEARTBEAT_INTERVAL = 30000;

// Task cleanup
export const TASK_CLEANUP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// File I/O
export const FILE_ENCODING = "utf-8" as const;
export const PACKAGE_JSON = "package.json";
