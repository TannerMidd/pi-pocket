#!/usr/bin/env node
// Pi Pocket's launcher entry. It checks the Node version, then runs src/launcher/main.ts (Node strips its types): pick
// how devices reach the server, then run it, restart it when the app asks (exit code 75, or SIGUSR2) or after a
// crash, and keep any tunnel up across restarts. Work in flight survives restarts: the durable harness resumes it.
const [major, minor] = process.versions.node.split(".").map(Number);

if (major < 22 || (major === 22 && minor < 19)) {
    console.error(`Pi Pocket needs Node.js 22.19 or newer (found ${process.versions.node}).`);
    process.exit(1);
}

await import("../src/launcher/main.ts");
