// Closes the default endpoint (127.0.0.1:5688) to the process that loads this module: a test's own
// process (import it) and the CLIs the test runs (NODE_OPTIONS, see importOption). A developer's own
// n2n-nexus-host may listen there, and a client whose LAN lookup finds nothing falls back to that
// endpoint: with this, a test whose lookup went wrong gets "connection refused" instead of an answer
// from that host, and the host gets no request from a test.
import net from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The port of LOCAL_ENDPOINT (src/client/discovery.ts); discovery.test.ts checks the two agree. */
export const DEFAULT_ENDPOINT_PORT = 5688;
/** What a refused connection's error says, so a test can tell this refusal from a real one. */
export const REFUSAL = "the default endpoint is closed to tests";
/** The NODE_OPTIONS value that loads this module into a Node process. */
export const importOption = `--import ${pathToFileURL(fileURLToPath(import.meta.url)).href}`;

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
    // net.connect() hands over its normalized arguments as one array; socket.connect() itself takes options or (port, host).
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    const options = typeof first === "object" && first !== null ? first : { port: first, host: typeof args[1] === "string" ? args[1] : undefined };
    const host = options.host ?? "localhost";
    if (Number(options.port) === DEFAULT_ENDPOINT_PORT && (host === "localhost" || host === "::1" || /^127\./.test(host))) {
        const error = Object.assign(new Error(`connect ECONNREFUSED ${host}:${DEFAULT_ENDPOINT_PORT} (${REFUSAL})`), { code: "ECONNREFUSED", syscall: "connect", address: host, port: DEFAULT_ENDPOINT_PORT });
        process.nextTick(() => this.destroy(error));
        return this;
    }
    return connect.apply(this, args);
};
