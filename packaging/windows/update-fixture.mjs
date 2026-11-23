// The fixture of the Windows update job (.github/workflows/windows.yml): a synthetic offline new version of Pi Pocket
// for the installed desktop app to update to, through the production updater, with no npm and no network at test time.
//
//   node update-fixture.mjs prepare <out> <source>   Make the synthetic version and its registry.
//   node update-fixture.mjs cert <out>                 Make the test CA and the registry's server certificate.
//   node update-fixture.mjs serve <out> [--port 443]   Serve the synthetic registry on 127.0.0.1 and [::1].
//
// `prepare` copies the checkout, bumps its version to `<major + 1>.0.0` in `package.json` and `package-lock.json` (a
// plain stable version npm has never had), installs the release's own production dependencies into that copy exactly
// as the installer does (`npm ci --omit=dev --ignore-scripts`), and packs the copy as a release is packed (`npm pack`,
// with the shrinkwrap) but with `bundleDependencies: true`: one self-contained tarball. `serve` answers only that one
// package: a hosts entry that sends registry.npmjs.org to 127.0.0.1 makes the updater's release check and its `npm
// install` read this server, so no real registry is reached and no version is published. Nothing here runs in the
// app: the production updater does, with the production trust checks (npm's own integrity, Node's own certificate
// validation through NODE_EXTRA_CA_CERTS).
import { spawnSync } from "node:child_process";
import {
    appendFileSync,
    cpSync,
    createReadStream,
    existsSync,
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createServer as createHttpsServer } from "node:https";
import { fileURLToPath } from "node:url";

const REGISTRY = "https://registry.npmjs.org/";

function fail(message) {
    console.error(`update-fixture: ${message}`);

    process.exit(1);
}

/** Run npm's own CLI with this Node.js, as packaging/bundle-app.mjs does: no shell, no PATH surprises. */
function npm(cwd, args) {
    const beside = dirname(process.execPath);
    // The official Windows zip keeps npm in `node_modules` beside node.exe; the Unix builds in `lib/node_modules`.
    const cli = [
        join(beside, "node_modules", "npm", "bin", "npm-cli.js"),
        join(beside, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    ].find((file) => existsSync(file));

    if (cli === undefined) {
        fail("no npm beside this Node.js: run the fixture with the runner's Node.");
    }

    console.log(`> npm ${args.join(" ")}`);
    const result = spawnSync(process.execPath, [cli, ...args], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
        maxBuffer: 64 * 1024 * 1024,
        timeout: 15 * 60_000,
    });

    if (result.status !== 0) {
        fail(
            `npm ${args[0]} exited with ${result.status ?? result.error?.message}\n${result.stdout}`,
        );
    }

    return result.stdout;
}

/** The synthetic version: the next major after the checkout's, a stable version npm has never had. */
export function syntheticVersion(version) {
    const major = /^(\d+)\./.exec(version)?.[1];

    if (major === undefined) {
        throw new Error(`"${version}" is not a version such as 0.31.0.`);
    }

    return `${Number(major) + 1}.0.0`;
}

async function prepare(out, source) {
    const checkout = resolve(source);
    const manifest = JSON.parse(readFileSync(join(checkout, "package.json"), "utf8"));
    const version = syntheticVersion(manifest.version);
    const work = join(out, "synthetic");

    rmSync(work, { recursive: true, force: true });
    console.log(`Copying ${checkout} (without .git and node_modules) into ${work}`);
    cpSync(checkout, work, {
        recursive: true,
        filter: (path) => basename(path) !== ".git" && basename(path) !== "node_modules",
    });

    // A release has its version in the package and the lock, and its dependencies as the lock pins them.
    for (const file of ["package.json", "package-lock.json"]) {
        const parsed = JSON.parse(readFileSync(join(work, file), "utf8"));

        parsed.version = version;

        if (parsed.packages?.[""] !== undefined) {
            parsed.packages[""].version = version;
        }

        // The synthetic release carries its dependencies inside, as `bundleDependencies`: the updater's staged
        // install then asks the registry for this one package only, and gets the release's own tree.
        if (file === "package.json") {
            parsed.bundleDependencies = true;
        }

        writeFileSync(join(work, file), `${JSON.stringify(parsed, null, 4)}\n`);
    }

    // The production dependencies of the release, as the installer's own bundle installs them.
    npm(work, ["ci", "--omit=dev", "--ignore-scripts"]);

    const packed = JSON.parse(npm(work, ["pack", "--json", "--pack-destination", out]))[0];

    for (const must of ["npm-shrinkwrap.json", "bin/pi-pocket.js"]) {
        if (packed.files?.every((file) => file.path !== must)) {
            fail(`the synthetic package has no ${must}.`);
        }
    }

    const bundled = (packed.files ?? []).filter((file) =>
        file.path.startsWith("node_modules/"),
    ).length;

    if (bundled === 0) {
        fail(
            "the synthetic package bundled no dependencies: the staged install would need the real registry.",
        );
    }

    console.log(
        `Packed pi-pocket ${version}: ${packed.filename}, ${(packed.size / 1024 / 1024).toFixed(1)} MB, ` +
            `${bundled} files of bundled dependencies.`,
    );

    // The synthetic release as a packument: what the updater's release check and npm's install read.
    const synthetic = JSON.parse(readFileSync(join(work, "package.json"), "utf8"));

    synthetic.dist = {
        tarball: `${REGISTRY}pi-pocket/-/pi-pocket-${version}.tgz`,
        integrity: packed.integrity,
    };
    const packuments = {
        "/pi-pocket": {
            contentType: "application/json",
            body: JSON.stringify({
                _id: "pi-pocket",
                name: "pi-pocket",
                "dist-tags": { latest: version },
                versions: { [version]: synthetic },
            }),
        },
    };

    // The pack left it in <out>; the server reads tarballs from <out>/tarballs.
    cpSync(join(out, packed.filename), join(out, "tarballs", packed.filename));
    rmSync(join(out, packed.filename), { force: true });
    const tarballs = {
        [`/pi-pocket/-/pi-pocket-${version}.tgz`]: { file: packed.filename, bytes: packed.size },
    };

    writeFileSync(
        join(out, "registry.json"),
        `${JSON.stringify({ version, packuments, tarballs }, null, 4)}\n`,
    );
    writeFileSync(join(out, "version.txt"), `${version}\n`);
    rmSync(join(out, "synthetic"), { recursive: true, force: true });
    console.log(
        `The synthetic release is pi-pocket@${version}: one self-contained package, ` +
            `${(packed.size / 1024 / 1024).toFixed(1)} MB.`,
    );
}

const OPENSSL = [
    process.env.OPENSSL,
    "openssl",
    "C:\\Program Files\\Git\\usr\\bin\\openssl.exe",
    "C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe",
    "C:\\Program Files (x86)\\Git\\usr\\bin\\openssl.exe",
].filter((each) => typeof each === "string" && each !== "");

function openssl(args, cwd) {
    for (const file of OPENSSL) {
        const result = spawnSync(file, args, { cwd, encoding: "utf8", timeout: 60_000 });

        if (!result.error) {
            if (result.status !== 0) {
                fail(`openssl ${args[0]} exited with ${result.status}: ${result.stderr}`);
            }

            return;
        }
    }

    fail(
        "no openssl found: the fixture makes its certificate with the openssl of Git for Windows.",
    );
}

function cert(out) {
    const days = 2;

    openssl(
        [
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-days",
            String(days),
            "-keyout",
            "ca.key",
            "-out",
            "ca.pem",
            "-subj",
            "/CN=Pi Pocket CI fixture CA",
        ],
        out,
    );
    openssl(
        [
            "req",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-keyout",
            "server.key",
            "-out",
            "server.csr",
            "-subj",
            "/CN=registry.npmjs.org",
        ],
        out,
    );
    writeFileSync(
        join(out, "server.ext"),
        [
            "basicConstraints=critical,CA:FALSE",
            "subjectAltName=DNS:registry.npmjs.org,DNS:registry.npmjs.com,IP:127.0.0.1,IP:0:0:0:0:0:0:0:1",
            "",
        ].join("\n"),
    );
    openssl(
        [
            "x509",
            "-req",
            "-in",
            "server.csr",
            "-CA",
            "ca.pem",
            "-CAkey",
            "ca.key",
            "-CAcreateserial",
            "-days",
            String(days),
            "-extfile",
            "server.ext",
            "-out",
            "server.pem",
        ],
        out,
    );
    rmSync(join(out, "server.csr"), { force: true });
    rmSync(join(out, "server.ext"), { force: true });
    rmSync(join(out, "ca.srl"), { force: true });
    rmSync(join(out, "ca.key"), { force: true });
    console.log(
        `Made the fixture CA (ca.pem) and the certificate of registry.npmjs.org, both for ${days} days.`,
    );
}

async function serve(out, port) {
    const store = JSON.parse(readFileSync(join(out, "registry.json"), "utf8"));
    const requests = join(out, "requests.log");

    const log = (line) => {
        console.log(line);

        try {
            appendFileSync(requests, `${new Date().toISOString()} ${line}\n`);
        } catch {}
    };

    const answer = (request, response) => {
        const raw = new URL(request.url, "https://registry.npmjs.org").pathname;
        let decoded = raw;

        try {
            decoded = decodeURIComponent(raw);
        } catch {}

        for (const path of [raw, decoded]) {
            const packument = store.packuments[path];

            if (packument !== undefined) {
                response.writeHead(200, { "content-type": packument.contentType });
                response.end(packument.body);
                log(`${request.method} ${raw} 200 packument`);

                return;
            }
        }

        const tarball = store.tarballs[raw] ?? store.tarballs[decoded];

        if (tarball !== undefined) {
            response.writeHead(200, { "content-type": "application/octet-stream" });
            createReadStream(join(out, "tarballs", tarball.file)).pipe(response);
            log(`${request.method} ${raw} 200 tarball`);

            return;
        }

        log(`${request.method} ${raw} 404`);
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: `not found: ${raw}` }));
    };

    const options = {
        key: readFileSync(join(out, "server.key")),
        cert: readFileSync(join(out, "server.pem")),
    };

    for (const host of ["127.0.0.1", "::1"]) {
        await new Promise((done, fail_) => {
            const server = createHttpsServer(options, answer);

            server.on("error", fail_);
            server.listen(port, host, done);
        });
    }

    console.log(
        `Serving the synthetic registry pi-pocket@${store.version} on 127.0.0.1:${port} and [::1]:${port}.`,
    );
}

async function main() {
    const [what, first, second] = process.argv.slice(2);

    if (what === "prepare" && first !== undefined && second !== undefined) {
        mkdirSync(join(first, "tarballs"), { recursive: true });
        await prepare(resolve(first), resolve(second));

        return;
    }

    if (what === "cert" && first !== undefined) {
        mkdirSync(first, { recursive: true });
        cert(resolve(first));

        return;
    }

    if (what === "serve" && first !== undefined) {
        const port = process.argv.includes("--port")
            ? Number(process.argv[process.argv.indexOf("--port") + 1])
            : 443;

        await serve(resolve(first), port);

        return;
    }

    console.error(
        "Usage: node update-fixture.mjs prepare <out> <source> | cert <out> | serve <out> [--port 443]",
    );

    process.exit(2);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    await main();
}
