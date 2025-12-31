/**
 * Error utility functions for path sanitization and reporting.
 */

/**
 * Strips internal file paths from error messages to prevent sensitive path exposure.
 */
export function sanitizeErrorMessage(msg: string): string {
    // Mask Windows paths (e.g. C:\Users\...)
    let sanitized = msg.replace(/[A-Za-z]:\\[^\s:]+/g, "[internal-path]");
    // Mask Unix paths (e.g. /home/user/...)
    sanitized = sanitized.replace(/\/[^\s:]+\/[^\s:]*/g, "[internal-path]");
    // Mask relative parent paths
    sanitized = sanitized.replace(/\.\.[\\/][^\s]*/g, "[internal-path]");
    return sanitized;
}
