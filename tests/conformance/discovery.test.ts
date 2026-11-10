import { afterAll, describe, expect, it } from "vitest";
import dgram from "node:dgram";

import { HOOK, useHost } from "./harness.js";

/** A UDP port nothing listens on right now. */
async function freeUdpPort(): Promise<number> {
    const socket = dgram.createSocket("udp4");
    await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", () => resolve()));
    const { port } = socket.address();
    await new Promise<void>((resolve) => socket.close(() => resolve()));
    return port;
}

const discoveryPort = await freeUdpPort();
const host = useHost({ bindHost: "0.0.0.0", discoveryPort });
const sockets: dgram.Socket[] = [];
afterAll(() => { for (const s of sockets) s.close(); });

/** Send `payload` to the host's discovery port and return its reply, or null when none comes within 500 ms. */
async function ask(payload: string): Promise<Buffer | null> {
    const socket = dgram.createSocket("udp4");
    sockets.push(socket);
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), 500);
        socket.on("message", (msg) => { clearTimeout(timer); resolve(msg); });
        socket.send(Buffer.from(payload), discoveryPort, "127.0.0.1");
    });
}

describe("LAN discovery", () => {
    const datagram = HOOK.discoveryQuery.padEnd(HOOK.discoveryQueryBytes, " ");

    it("answers the discovery datagram with the HTTP port, never with more bytes than it got", async () => {
        const reply = await ask(datagram);
        expect(reply).not.toBeNull();
        expect(JSON.parse(reply!.toString("utf8"))).toMatchObject({ service: "n2n-nexus", host: "0.0.0.0", port: host.port });
        expect(reply!.length).toBeLessThanOrEqual(Buffer.byteLength(datagram));
    });

    it("ignores the bare query and any other datagram, so it amplifies nothing", async () => {
        for (const other of [HOOK.discoveryQuery, datagram.slice(0, -1), datagram + " ", "something else"]) {
            expect(await ask(other)).toBeNull();
        }
    });
});
