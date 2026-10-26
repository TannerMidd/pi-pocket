import { glob, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

const ALIAS = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

export function validAlias(value: unknown): value is string {
    return typeof value === "string" && ALIAS.test(value);
}

// Only inventory aliases here; OpenSSH itself evaluates Host, Match, Include and connection settings.
export function configWords(line: string): string[] {
    const words: string[] = [];
    let word = "";
    let quote = "";
    let escaped = false;

    for (const char of line) {
        if (escaped) {
            word += char;
            escaped = false;
        } else if (char === "\\") {
            escaped = true;
        } else if (quote) {
            if (char === quote) {
                quote = "";
            } else {
                word += char;
            }
        } else if (char === '"' || char === "'") {
            quote = char;
        } else if (char === "#") {
            break;
        } else if (/\s/.test(char) || (char === "=" && words.length === 0)) {
            if (word) {
                words.push(word);
                word = "";
            }
        } else {
            word += char;
        }
    }

    if (word) {
        words.push(word);
    }

    return words;
}

export async function sshAliases(home = homedir()): Promise<string[]> {
    const aliases = new Set<string>();
    const visited = new Set<string>();
    const sshDir = join(home, ".ssh");
    const pending = [join(sshDir, "config")];

    while (pending.length) {
        const file = pending.shift()!;

        if (visited.has(file)) {
            continue;
        }

        if (visited.size >= 128) {
            throw new Error("Too many Include files in the SSH configuration (limit: 128).");
        }

        visited.add(file);
        let source: string;

        try {
            source = await readFile(file, "utf8");
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                continue;
            }

            throw error;
        }

        if (Buffer.byteLength(source) > 1_048_576) {
            throw new Error("An SSH configuration file exceeds 1 MiB.");
        }

        for (const line of source.split(/\r?\n/)) {
            const [key, ...values] = configWords(line);

            if (key?.toLowerCase() === "host") {
                for (const alias of values) {
                    if (validAlias(alias)) {
                        aliases.add(alias);
                    }
                }
            } else if (key?.toLowerCase() === "include") {
                for (const value of values) {
                    const expanded = value.startsWith("~/") ? join(home, value.slice(2)) : value;
                    const pattern = isAbsolute(expanded) ? expanded : join(sshDir, expanded);

                    for await (const included of glob(pattern)) {
                        pending.push(included);
                    }
                }
            }
        }
    }

    return [...aliases].sort((a, b) => a.localeCompare(b));
}

export function workspaceUri(alias: string, path: string): string {
    if (!validAlias(alias) || !path.startsWith("/") || /[\0\r\n]/.test(path)) {
        throw new Error("Invalid SSH host or directory.");
    }

    return `ssh://${alias}${path.split("/").map(encodeURIComponent).join("/")}`;
}

export function parseWorkspace(cwd: string): { alias: string; path: string } {
    const match = /^ssh:\/\/([^/]+)(\/[^?#]*)$/.exec(cwd);

    if (!match || !validAlias(match[1])) {
        throw new Error("Invalid SSH session address.");
    }

    let path: string;

    try {
        path = decodeURIComponent(match[2]);
    } catch {
        throw new Error("Invalid SSH session path.");
    }

    if (/[\0\r\n]/.test(path)) {
        throw new Error("Invalid SSH session path.");
    }

    return { alias: match[1], path };
}
