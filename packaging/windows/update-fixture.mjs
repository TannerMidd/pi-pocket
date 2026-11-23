// A one-package HTTPS registry for the installed-update job. Only its hosted runner maps
// registry.npmjs.org to loopback and gives the desktop app NODE_EXTRA_CA_CERTS.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, createReadStream, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { dirname, join, resolve } from "node:path";
import { once } from "node:events";

const [command, directory, installed] = process.argv.slice(2);
const out = resolve(directory);
const read = (file) => JSON.parse(readFileSync(file, "utf8"));
const write = (file, value) => writeFileSync(file, JSON.stringify(value));
const registry = "https://registry.npmjs.org";

function pack() {
    // Use Setup's actual dependency tree. Do not install twice or run pack scripts in the checkout.
    const copy = join(out, "package");

    cpSync(installed, copy, { recursive: true, verbatimSymlinks: true });

    const manifest = read(join(copy, "package.json"));
    const lock = read(join(copy, "npm-shrinkwrap.json"));
    const version = `${Number(manifest.version.split(".")[0]) + 1}.0.0`;

    manifest.version = lock.version = lock.packages[""].version = version;
    manifest.bundleDependencies = Object.keys(manifest.dependencies);
    write(join(copy, "package.json"), manifest);
    write(join(copy, "npm-shrinkwrap.json"), lock);

    // Invoke the JS entry point beside this Node, not npm.cmd (which needs cmd.exe and quoting).
    const lib = process.platform === "win32" ? "." : "../lib";
    const cli = join(dirname(process.execPath), lib, "node_modules/npm/bin/npm-cli.js");
    const [packed] = JSON.parse(
        execFileSync(
            process.execPath,
            [cli, "pack", "--ignore-scripts", "--json", "--pack-destination", out],
            {
                cwd: copy,
                encoding: "utf8",
                maxBuffer: 64 * 1024 * 1024,
            },
        ),
    );

    assert(packed.files.some((file) => file.path === "npm-shrinkwrap.json"));
    assert(packed.files.some((file) => file.path === "bin/pi-pocket.js"));
    assert(manifest.bundleDependencies.every((dep) => packed.bundled.includes(dep)));
    const tarball = `${registry}/pi-pocket/-/${packed.filename}`;

    manifest.dist = { tarball, integrity: packed.integrity };
    write(join(out, "registry.json"), {
        name: "pi-pocket",
        "dist-tags": { latest: version },
        versions: { [version]: manifest },
    });
    rmSync(copy, { recursive: true });
}

function certificates() {
    const run = (args) =>
        execFileSync(process.env.OPENSSL || "openssl", args.split(" "), { cwd: out });

    // Git for Windows and other OpenSSL distributions need not share a default config path.
    writeFileSync(join(out, "openssl.cnf"), "[req]\ndistinguished_name = dn\n[dn]\n");
    const req = "req -config openssl.cnf -newkey rsa:2048 -nodes";

    run(
        `${req} -x509 -days 2 -subj /CN=Fixture-CA -addext basicConstraints=critical,CA:TRUE -addext keyUsage=critical,keyCertSign,cRLSign -keyout ca.key -out ca.pem`,
    );
    run(`${req} -subj /CN=registry.npmjs.org -keyout server.key -out server.csr`);
    writeFileSync(
        join(out, "server.ext"),
        "basicConstraints=CA:FALSE\nsubjectAltName=DNS:registry.npmjs.org\n",
    );
    run(
        "x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 2 -extfile server.ext -out server.pem",
    );
    rmSync(join(out, "ca.key"));
}

async function serve() {
    const metadata = read(join(out, "registry.json"));
    const version = metadata["dist-tags"].latest;
    const filename = `pi-pocket-${version}.tgz`;
    const tls = {
        key: readFileSync(join(out, "server.key")),
        cert: readFileSync(join(out, "server.pem")),
    };

    for (const host of ["127.0.0.1", "::1"]) {
        const server = createServer(tls, (req, res) => {
            if (req.method === "GET" && req.url === "/pi-pocket") {
                res.writeHead(200, { "Content-Type": "application/json" }).end(
                    JSON.stringify(metadata),
                );
            } else if (req.method === "GET" && req.url === `/pi-pocket/-/${filename}`) {
                res.on("finish", () => writeFileSync(join(out, "tarball-served"), version));
                createReadStream(join(out, filename)).pipe(res);
            } else {
                res.writeHead(404).end();
            }
        });

        server.listen(443, host);
        await once(server, "listening");
    }

    writeFileSync(join(out, "ready"), version);
}

if (command === "prepare") {
    mkdirSync(out); // Must be a new directory under RUNNER_TEMP, never the checkout.
    pack();
    certificates();
} else if (command === "serve") {
    await serve();
} else {
    throw new Error(
        "Expected prepare <new-fixture-dir> <installed-pi-pocket> or serve <fixture-dir>",
    );
}
