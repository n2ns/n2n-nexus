import { describe, expect, it } from "vitest";

import { hostnameOf, machineInfo, platformOf } from "../src/cli/machine.js";

describe("machine information the hooks forward", () => {
    it("tells WSL from Linux by /proc/version and passes the other platforms through", () => {
        expect(platformOf("linux", () => "Linux version 6.6.87.2-microsoft-standard-WSL2 (root@x)")).toBe("wsl");
        expect(platformOf("linux", () => "Linux version 6.8.0-45-generic (buildd@lcy02)")).toBe("linux");
        expect(platformOf("linux", () => { throw new Error("ENOENT"); })).toBe("linux");
        expect(platformOf("darwin", () => { throw new Error("not read"); })).toBe("darwin");
        expect(platformOf("win32", () => { throw new Error("not read"); })).toBe("win32");
    });

    it("drops the .local suffix macOS adds to the host name", () => {
        expect(hostnameOf("MacBook-Air.local")).toBe("MacBook-Air");
        expect(hostnameOf("DESKTOP-01")).toBe("DESKTOP-01");
    });

    it("reports the offset of local time from UTC in minutes, never -0", () => {
        const now = new Date();
        expect(machineInfo(now).utcOffset).toBe(0 - now.getTimezoneOffset());
        expect(Object.is(machineInfo({ getTimezoneOffset: () => 0 } as Date).utcOffset, 0)).toBe(true);
    });
});
