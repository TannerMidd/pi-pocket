#!/usr/bin/env node
// Pi Pocket's launcher entry. It checks the Node version, then runs src/launcher/main.ts (Node strips its types): pick
// how devices reach the server, then run it, restart it when the app asks (exit code 75, or SIGUSR2) or after a
// crash, and keep any tunnel up across restarts. Work in flight survives restarts: the durable harness resumes it.
const [major, minor] = process.versions.node.split(".").map(Number);

if (major < 22 || (major === 22 && minor < 19)) {
    console.error(`Pi Pocket needs Node.js 22.19 or newer (found ${process.versions.node}).`);
    process.exit(1);
}

// The first release of each line with the October 21, 2026 security fixes (TLS hostname checks, Brotli,
// dns.resolve). Older ones still run, with a warning; a line not listed here gets none.
const patched = { 22: [23, 4], 24: [22, 1], 26: [12, 1] };
const patch = Number(process.versions.node.split(".")[2]);
const fixed = patched[major];

if (fixed && (minor < fixed[0] || (minor === fixed[0] && patch < fixed[1]))) {
    console.warn(
        `Node.js ${process.versions.node} lacks security fixes: update to ${major}.${fixed.join(".")} or newer.`,
    );
}

await import("../src/launcher/main.ts");
