import { describe, expect, it } from "vitest";

import { environmentOf, hostnameOf, machineInfo, platformOf } from "../src/cli/machine.js";

describe("machine information the hooks forward", () => {
    it("tells WSL from Linux by /proc/version and passes the other platforms through", () => {
        expect(platformOf("linux", () => "Linux version 6.6.87.2-microsoft-standard-WSL2 (root@x)")).toBe("wsl");
        expect(platformOf("linux", () => "Linux version 6.8.0-45-generic (buildd@lcy02)")).toBe("linux");
        expect(platformOf("linux", () => { throw new Error("ENOENT"); })).toBe("linux");
        expect(platformOf("darwin", () => { throw new Error("not read"); })).toBe("darwin");
        expect(platformOf("win32", () => { throw new Error("not read"); })).toBe("win32");
    });

    it("names a Mac by its ComputerName, else by the host name without .local", () => {
        expect(hostnameOf("darwin", "MacBook-Air.local", () => "Studio Mac\n")).toBe("Studio Mac");
        expect(hostnameOf("darwin", "MacBook-Air.local", () => { throw new Error("no scutil"); })).toBe("MacBook-Air");
        expect(hostnameOf("darwin", "MacBook-Air.local", () => "")).toBe("MacBook-Air");
        expect(hostnameOf("win32", "DESKTOP-01", () => { throw new Error("not read"); })).toBe("DESKTOP-01");
        expect(hostnameOf("linux", "box.local", () => "ignored")).toBe("box");
    });

    it("reports the WSL distribution as the environment, and nothing elsewhere", () => {
        expect(environmentOf("wsl", { WSL_DISTRO_NAME: "Ubuntu_26_Dev" })).toBe("Ubuntu_26_Dev");
        expect(environmentOf("wsl", {})).toBe("");
        expect(environmentOf("linux", { WSL_DISTRO_NAME: "x" })).toBe("");
        expect(environmentOf("win32", { WSL_DISTRO_NAME: "x" })).toBe("");
    });

    it("reports the offset of local time from UTC in minutes, never -0", () => {
        const now = new Date();
        expect(machineInfo(now).utcOffset).toBe(0 - now.getTimezoneOffset());
        expect(Object.is(machineInfo({ getTimezoneOffset: () => 0 } as Date).utcOffset, 0)).toBe(true);
    });
});
