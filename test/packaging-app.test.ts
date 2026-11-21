import assert from "node:assert/strict";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

type Place = {
    compareVersions: (a: string, b: string) => number;
    versionIn: (prefix: string) => string | undefined;
    placeApp: (here: string, version: string, log: (line: string) => void) => number;
};
type Bundle = {
    checkApp: (prefix: string, version: string, platform?: string) => string[];
};

const place = (await import(
    new URL("../packaging/macos/place-app.mjs", import.meta.url).href
)) as Place;
const bundle = (await import(
    new URL("../packaging/bundle-app.mjs", import.meta.url).href
)) as Bundle;
const root = mkdtempSync(join(realpathSync(tmpdir()), "pp-packaging-"));

after(() => rmSync(root, { recursive: true, force: true }));

function prefix(path: string, version: string, packages: Record<string, object> = {}) {
    const folder = join(path, "lib", "node_modules", "pi-pocket");

    mkdirSync(join(folder, "bin"), { recursive: true });
    mkdirSync(join(path, "bin"), { recursive: true });
    writeFileSync(join(folder, "bin", "pi-pocket.js"), "");
    writeFileSync(join(folder, "package.json"), JSON.stringify({ name: "pi-pocket", version }));
    writeFileSync(
        join(folder, "npm-shrinkwrap.json"),
        JSON.stringify({ packages: { "": { version }, ...packages } }),
    );
    symlinkSync("../lib/node_modules/pi-pocket/bin/pi-pocket.js", join(path, "bin", "pi-pocket"));

    return path;
}

test("versions sort as SemVer, with a pre-release before its release", () => {
    const sorted = [
        "0.0.1",
        "0.29.9",
        "0.30.0-beta.1",
        "0.30.0-beta.2",
        "0.30.0-beta.10",
        "0.30.0",
        "0.30.1",
        "99.0.0",
    ];

    for (let left = 0; left < sorted.length; left++) {
        for (let right = 0; right < sorted.length; right++) {
            assert.equal(
                place.compareVersions(sorted[left]!, sorted[right]!),
                Math.sign(left - right),
                `${sorted[left]} against ${sorted[right]}`,
            );
        }
    }
});

test("the macOS install puts the bundled package in place of an older one, and keeps a newer one", () => {
    const here = join(root, "place");
    const lines: string[] = [];

    prefix(join(here, "app"), "0.30.0-beta.1");
    prefix(join(here, "app.new"), "0.30.0-beta.3");
    assert.equal(
        place.placeApp(here, "0.30.0-beta.3", (line) => lines.push(line)),
        0,
    );
    assert.equal(place.versionIn(join(here, "app")), "0.30.0-beta.3");
    assert.ok(!existsSync(join(here, "app.new")) && !existsSync(join(here, "app.old")));

    prefix(join(here, "app.new"), "0.30.0-beta.3");
    writeFileSync(
        join(here, "app", "lib", "node_modules", "pi-pocket", "package.json"),
        JSON.stringify({ version: "0.31.0" }),
    );
    assert.equal(
        place.placeApp(here, "0.30.0-beta.3", (line) => lines.push(line)),
        0,
    );
    assert.equal(place.versionIn(join(here, "app")), "0.31.0");
    assert.ok(!existsSync(join(here, "app.new")));
    assert.match(lines.join("\n"), /pi-pocket 0\.31\.0 is newer than 0\.30\.0-beta\.3: it stays\./);
});

test("the macOS install fails, and leaves no newer-looking package, when the payload has the wrong one", () => {
    const here = join(root, "wrong");

    prefix(join(here, "app"), "0.30.0-beta.1");
    prefix(join(here, "app.new"), "0.30.0-beta.2");
    assert.equal(
        place.placeApp(here, "0.30.0-beta.3", () => {}),
        1,
    );
    assert.equal(place.versionIn(join(here, "app")), "0.30.0-beta.1");
});

test("the build refuses an app folder of another version, without a shrinkwrap, or with a package for one platform", () => {
    const good = prefix(join(root, "good"), "1.2.3", { "node_modules/a": { version: "1.0.0" } });

    assert.deepEqual(bundle.checkApp(good, "1.2.3", "darwin"), []);
    assert.match(
        bundle.checkApp(good, "1.2.4", "darwin").join("\n"),
        /version 1\.2\.3, not 1\.2\.4/,
    );

    const native = prefix(join(root, "native"), "1.2.3", {
        "node_modules/@x/darwin-arm64": {
            version: "1.0.0",
            os: ["darwin"],
            cpu: ["arm64"],
            optional: true,
        },
        "node_modules/@x/tool": { version: "1.0.0", os: ["linux"], dev: true },
    });

    assert.deepEqual(bundle.checkApp(native, "1.2.3", "darwin"), [
        "node_modules/@x/darwin-arm64 is for one platform only: build the app folder for each platform",
    ]);

    rmSync(join(good, "lib", "node_modules", "pi-pocket", "npm-shrinkwrap.json"));
    assert.match(bundle.checkApp(good, "1.2.3", "darwin").join("\n"), /no npm-shrinkwrap\.json/);
});
