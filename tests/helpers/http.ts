import http from "node:http";
import type { AddressInfo } from "node:net";

export type Listening = { server: http.Server; port: number; endpoint: string; close: () => Promise<void> };

/** An HTTP server with `handler` on 127.0.0.1 (port 0: a free one unless `port` says otherwise). */
export async function listen(handler?: http.RequestListener, port = 0): Promise<Listening> {
    const server = http.createServer(handler);
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", () => resolve()));
    const bound = (server.address() as AddressInfo).port;
    return {
        server,
        port: bound,
        endpoint: `http://127.0.0.1:${bound}`,
        close: () => new Promise<void>((resolve) => server.close(() => resolve()))
    };
}

/** A loopback port that was free a moment ago and nothing listens on. */
export async function closedPort(): Promise<number> {
    const { port, close } = await listen();
    await close();
    return port;
}
