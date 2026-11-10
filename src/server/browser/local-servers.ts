/** Web servers running on this machine, or ports another computer listens on, for the Browser panel's start screen. */
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { BACKGROUND_CONTEXT as BACKGROUND } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";

/** TCP ports this machine listens on, from Linux's /proc; none elsewhere. `v6only`: listening on IPv6 alone. */
function listeningPorts(): Map<number, { v6only: boolean }> {
    const ports = new Map<number, { v4: boolean; v6: boolean }>();

    for (const [file, v6] of [
        ["/proc/net/tcp", false],
        ["/proc/net/tcp6", true],
    ] as const) {
        let text: string;

        try {
            text = readFileSync(file, "utf8");
        } catch {
            continue;
        }

        for (const line of text.split("\n").slice(1)) {
            const fields = line.trim().split(/\s+/);

            if (fields[3] !== "0A") {
                continue;
            }

            const [address = "", hex = ""] = (fields[1] ?? "").split(":");
            const port = Number.parseInt(hex, 16);

            if (!Number.isInteger(port)) {
                continue;
            }

            // Loopback or every address: the ones this machine's browser reaches as localhost.
            const local = v6
                ? /^(0{32}|0{24}01000000|0{16}FFFF0000(0{8}|[0-9A-F]{6}7F))$/i.test(address)
                : /^(00000000|[0-9A-F]{6}7F)$/i.test(address);

            if (!local) {
                continue;
            }

            const entry = ports.get(port) ?? { v4: false, v6: false };

            if (v6) {
                entry.v6 = true;
            } else {
                entry.v4 = true;
            }

            ports.set(port, entry);
        }
    }

    return new Map([...ports].map(([port, entry]) => [port, { v6only: entry.v6 && !entry.v4 }]));
}

/** Whether a port answers http, and the title of its page. */
function probe(port: number, v6only: boolean): Promise<{ title: string } | undefined> {
    return new Promise((done) => {
        const request = httpRequest(
            {
                host: v6only ? "::1" : "127.0.0.1",
                port,
                path: "/",
                method: "GET",
                timeout: 800,
                headers: { accept: "text/html" },
            },
            (response) => {
                let body = "";

                response.setEncoding("utf8");
                response.on("data", (chunk: string) => {
                    body += chunk;

                    if (body.length > 65_536) {
                        response.destroy();
                    }
                });
                const finish = () =>
                    done({
                        title: (/<title[^>]*>([^<]*)<\/title>/i.exec(body)?.[1] ?? "")
                            .replace(/\s+/g, " ")
                            .trim()
                            .slice(0, 80),
                    });

                response.on("end", finish);
                response.on("close", finish);
            },
        );

        request.on("timeout", () => request.destroy());
        request.on("error", () => done(undefined));
        request.end();
    });
}

/**
 * Web servers running on this machine, such as a dev server, for the Browser panel to offer: ports from 1024 to 32767
 * that answer http, without `exclude` (Pi Pocket's own). Linux only.
 */
export async function localServers(
    exclude: readonly number[] = [],
): Promise<{ port: number; url: string; title: string }[]> {
    // Above 32767 are mostly the system's passing connections and services' private ports.
    const ports = [...listeningPorts()]
        .filter(([port]) => port >= 1024 && port <= 32767 && !exclude.includes(port))
        .slice(0, 40);
    const found = await Promise.all(
        ports.map(async ([port, { v6only }]) => ({ port, answer: await probe(port, v6only) })),
    );

    return found
        .filter((each) => each.answer !== undefined)
        .map((each) => ({
            port: each.port,
            url: `http://localhost:${each.port}/`,
            title: each.answer!.title,
        }))
        .sort((a, b) => a.port - b.port);
}

/** The command that lists the TCP ports a computer listens on, for its system (Node's or Rust's name of it). */
function listCommand(os: string): string | undefined {
    if (os === "darwin" || os === "macos") {
        return "lsof -nP -iTCP -sTCP:LISTEN";
    }

    if (os === "linux") {
        return "cat /proc/net/tcp /proc/net/tcp6 2>/dev/null || ss -ltn";
    }

    if (os === "win32" || os === "windows") {
        return "netstat -ano -p TCP";
    }

    return undefined;
}

/**
 * The ports in what `listCommand` printed that the computer's own localhost reaches: listening on loopback or on every
 * address. Reads `/proc/net/tcp`, `ss -ltn`, `lsof`, and `netstat` output.
 */
export function parseListening(text: string): number[] {
    const ports = new Set<number>();
    const local = (address: string) =>
        /^(\*|0\.0\.0\.0|127\.\d+\.\d+\.\d+|\[?::1?\]?|\[?::ffff:127\.\d+\.\d+\.\d+\]?)$/i.test(
            address,
        );

    for (const line of text.split(/\r?\n/)) {
        const fields = line.trim().split(/\s+/);

        // /proc/net/tcp(6): `sl local_address rem_address st …`, hex, state 0A is LISTEN.
        if (/^\d+:$/.test(fields[0] ?? "") && fields[3] === "0A") {
            const [address = "", hex = ""] = (fields[1] ?? "").split(":");
            const port = Number.parseInt(hex, 16);
            const loopback =
                /^(00000000|[0-9A-F]{6}7F)$/i.test(address) ||
                /^(0{32}|0{24}01000000|0{16}FFFF0000(0{8}|[0-9A-F]{6}7F))$/i.test(address);

            if (loopback && Number.isInteger(port)) {
                ports.add(port);
            }

            continue;
        }

        // lsof: `… TCP 127.0.0.1:5173 (LISTEN)`; ss: `LISTEN 0 511 127.0.0.1:5173 …`; netstat: `TCP 0.0.0.0:135 … LISTENING`.
        const listening = /\(LISTEN\)|^LISTEN\b|\bLISTENING\b/.test(line.trim());

        if (!listening) {
            continue;
        }

        for (const field of fields) {
            const match = /^(.*):(\d{1,5})$/.exec(field);

            if (match !== null && local(match[1]!)) {
                ports.add(Number(match[2]));
                break;
            }
        }
    }

    return [...ports].sort((a, b) => a - b);
}

/**
 * Ports from 1024 to 32767 that another computer listens on, for its own localhost, through its environment; none when
 * that fails. Its pages are not probed: the list shows ports, not titles.
 */
export async function computerServers(
    env: ExecutionEnv,
    os: string,
): Promise<{ port: number; url: string; title: string }[]> {
    const command = listCommand(os);

    if (command === undefined) {
        return [];
    }

    let output = "";
    const ran = await env
        .exec(
            command,
            {
                timeout: 5,
                onOutput: (text, _context, info) => {
                    if (info.stream === "stdout" && output.length < 1_000_000) {
                        output += text;
                    }
                },
            },
            BACKGROUND,
        )
        .catch(() => undefined);

    if (ran === undefined || !ran.ok) {
        return [];
    }

    return parseListening(output)
        .filter((port) => port >= 1024 && port <= 32767)
        .slice(0, 40)
        .map((port) => ({ port, url: `http://localhost:${port}/`, title: "" }));
}
