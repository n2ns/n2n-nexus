/**
 * LAN discovery of a host, query side. An n2n-nexus-host bound to a
 * non-loopback address answers UDP queries on the discovery port; a client
 * configured with the endpoint `discover` broadcasts a query, uses the first
 * host that answers and caches it in `~/.n2n-nexus/discovered-endpoint`. When
 * none answers it falls back to the local default endpoint (a host running on
 * this machine); it never starts a host or makes one reachable from the LAN.
 *
 * Node built-ins only (and contract.ts): the hook command imports this on every client event.
 */
import dgram from "node:dgram";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isIPv6 } from "node:net";

import { DISCOVERY_QUERY } from "../contract.js";

/** Endpoint value that turns discovery on (NEXUS_ENDPOINT or --endpoint). */
export const DISCOVER_ENDPOINT = "discover";
export const LOCAL_ENDPOINT = "http://127.0.0.1:5688";
export const DEFAULT_DISCOVERY_PORT = 5688;
const DISCOVERY_WAIT_MS = 1000;
/** How long "no daemon answered" stays cached before the next lookup. */
const NOT_FOUND_TTL_MS = 60_000;

/** `host` is the host's bind address: a client on the same machine needs it unless it covers all interfaces. */
type DiscoveryReply = { service: "n2n-nexus"; version: string; host: string; port: number };
const ALL_INTERFACES = new Set(["0.0.0.0", "::", ""]);

/** UDP port of discovery queries (NEXUS_DISCOVERY_PORT, default 5688). */
function discoveryPort(): number {
    const parsed = parseInt(process.env.NEXUS_DISCOVERY_PORT || "", 10);
    return parsed > 0 ? parsed : DEFAULT_DISCOVERY_PORT;
}

/** The endpoint to use: `value` (e.g. `--endpoint`) when set, else NEXUS_ENDPOINT, else LOCAL_ENDPOINT. */
export function configuredEndpoint(value?: string): string {
    return value || process.env.NEXUS_ENDPOINT || LOCAL_ENDPOINT;
}

/** IPv4 LAN interfaces of this machine. */
function lanInterfaces(): os.NetworkInterfaceInfoIPv4[] {
    return Object.values(os.networkInterfaces()).flatMap((addresses) => addresses ?? [])
        .filter((a): a is os.NetworkInterfaceInfoIPv4 => a.family === "IPv4" && !a.internal);
}

/** Directed broadcast address of every IPv4 LAN interface, plus the limited broadcast and loopback. */
function queryTargets(): string[] {
    const targets = new Set(["255.255.255.255", "127.0.0.1"]);
    for (const a of lanInterfaces()) {
        const ip = a.address.split(".").map(Number);
        const mask = a.netmask.split(".").map(Number);
        targets.add(ip.map((octet, i) => (octet | (~mask[i] & 255))).join("."));
    }
    return [...targets];
}

/** Broadcast a query and return the endpoint of the first daemon that answers, or null. */
export function discoverEndpoint(udpPort = discoveryPort(), waitMs = DISCOVERY_WAIT_MS): Promise<string | null> {
    // A daemon on this machine answers from loopback or one of its own addresses: use loopback when it
    // listens on all interfaces, else the one address it is bound to.
    const own = new Set(lanInterfaces().map((a) => a.address));
    const address = (rinfo: dgram.RemoteInfo, reply: Partial<DiscoveryReply>) => {
        const local = own.has(rinfo.address) || rinfo.address.startsWith("127.");
        if (typeof reply.host === "string" && isIPv6(reply.host)) {
            const host = new URL(`http://[${reply.host}]`).hostname;
            // The IPv4 discovery source cannot identify an IPv6-only listener on another machine.
            return host === "[::]" ? (local ? "[::1]" : null) : host;
        }
        if (!local) return rinfo.address;
        return typeof reply.host === "string" && !ALL_INTERFACES.has(reply.host) ? reply.host : "127.0.0.1";
    };
    return new Promise((resolve) => {
        const socket = dgram.createSocket("udp4");
        let done = false;
        const finish = (endpoint: string | null) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            socket.close();
            resolve(endpoint);
        };
        const timer = setTimeout(() => finish(null), waitMs);
        socket.on("error", () => finish(null));
        socket.on("message", (msg, rinfo) => {
            try {
                const reply = JSON.parse(msg.toString("utf8")) as Partial<DiscoveryReply>;
                if (reply.service === "n2n-nexus" && Number.isInteger(reply.port) && reply.port! > 0) {
                    const host = address(rinfo, reply);
                    if (host !== null) finish(`http://${host}:${reply.port}`);
                }
            } catch { /* not a discovery reply */ }
        });
        socket.bind(0, () => {
            socket.setBroadcast(true);
            const query = Buffer.from(DISCOVERY_QUERY);
            for (const target of queryTargets()) socket.send(query, udpPort, target, () => { });
        });
    });
}

const cacheFile = () => path.join(os.homedir(), ".n2n-nexus", "discovered-endpoint");

/** The cached lookup result and its age, or null when there is none. */
export function cachedEndpoint(): { endpoint: string; ageMs: number } | null {
    try {
        const endpoint = fs.readFileSync(cacheFile(), "utf8").trim();
        return endpoint ? { endpoint, ageMs: Date.now() - fs.statSync(cacheFile()).mtimeMs } : null;
    } catch {
        return null;
    }
}

/**
 * The endpoint to use for a configured value: anything but `discover` as is.
 * For `discover`: the cached result unless `fresh`, else a lookup. A found
 * daemon stays cached until a client fails to reach it and looks again; "none
 * answered" (the local default) is cached for NOT_FOUND_TTL_MS so hooks do not
 * wait for a lookup on every event.
 */
export async function resolveEndpoint(configured: string, options: { fresh?: boolean } = {}): Promise<string> {
    if (configured !== DISCOVER_ENDPOINT) return configured;
    const cached = options.fresh ? null : cachedEndpoint();
    if (cached && (cached.endpoint !== LOCAL_ENDPOINT || cached.ageMs < NOT_FOUND_TTL_MS)) return cached.endpoint;
    const endpoint = await discoverEndpoint() ?? LOCAL_ENDPOINT;
    try {
        fs.mkdirSync(path.dirname(cacheFile()), { recursive: true });
        fs.writeFileSync(cacheFile(), endpoint + "\n");
    } catch { /* caching is best effort */ }
    return endpoint;
}
