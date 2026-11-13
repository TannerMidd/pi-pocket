/** What the browser tells pages it is: the brands and versions in its client hints, the platform of this machine. */
import { arch, platform, release } from "node:os";
import { basename } from "node:path";

type Os = { platform: string; arch: string; release: string };

/** The name of the browser. `Browser.getVersion` says `Chrome` for Chromium and Brave too, so the executable tells them apart. */
export function brandName(product: string, executable: string): string {
    const name = /^(?:Headless)?([A-Za-z]+)\//.exec(product)?.[1] ?? "Chrome";
    const path = executable.toLowerCase();
    const file = basename(path);

    if (name.startsWith("Edg") || file.includes("edge")) {
        return "Microsoft Edge";
    }

    if (path.includes("brave")) {
        return "Brave";
    }

    return path.includes("chromium") || !file.includes("chrome") ? "Chromium" : "Google Chrome";
}

/** `Emulation.setUserAgentOverride`'s `userAgentMetadata` (client hints) for a version such as `155.0.8059.84`. */
export function clientHints(
    brand: string,
    version: string,
    mobile: boolean,
    os: Os = { platform: platform(), arch: arch(), release: release() },
) {
    const major = version.split(".")[0] ?? "0";
    const named = brand === "Chromium" ? [] : [brand];
    const list = (of: (version: string) => string) => [
        { brand: "Not.A/Brand", version: of("8") },
        { brand: "Chromium", version: of(major) },
        ...named.map((name) => ({ brand: name, version: of(major) })),
    ];
    const desktop = {
        linux: ["Linux", os.release.split("-")[0] ?? ""],
        darwin: ["macOS", ""],
        win32: ["Windows", os.release],
    }[os.platform] ?? ["Linux", ""];

    return {
        brands: list((v) => v),
        fullVersionList: list((v) => (v === major ? version : `${v}.0.0.0`)),
        fullVersion: version,
        platform: mobile ? "Android" : (desktop[0] as string),
        platformVersion: mobile ? "14.0.0" : (desktop[1] as string),
        architecture: mobile ? "" : os.arch === "arm64" ? "arm" : "x86",
        model: mobile ? "Pixel 8" : "",
        mobile,
        bitness: mobile ? "" : "64",
    };
}
