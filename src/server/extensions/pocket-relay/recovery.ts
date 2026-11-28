import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ConnectorConfig, Relay } from "./runtime.ts";

type State = ReturnType<Relay["stateOf"]>;

const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
const string = (value: unknown): value is string => typeof value === "string";
const nonempty = (value: unknown): value is string => string(value) && value.length > 0;
const number = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value);
const count = (value: unknown): boolean =>
    number(value) && Number.isSafeInteger(value) && value >= 0;
const boolean = (value: unknown): boolean => typeof value === "boolean";
const optional = (value: unknown, check: (v: unknown) => boolean): boolean =>
    value === undefined || check(value);
const list = (value: unknown, check: (v: unknown) => boolean): boolean =>
    Array.isArray(value) && value.every(check);

function config(value: unknown, id: string): value is ConnectorConfig {
    return (
        record(value) &&
        value.id === id &&
        nonempty(id) &&
        nonempty(value.name) &&
        nonempty(value.kind) &&
        nonempty(value.by) &&
        number(value.target) &&
        Number.isSafeInteger(value.target) &&
        optional(value.revision, nonempty) &&
        boolean(value.enabled) &&
        string(value.instructions) &&
        list(value.ownerIds, nonempty) &&
        boolean(value.mentionOnly) &&
        count(value.perHour) &&
        count(value.perAuthor) &&
        number(value.createdAt) &&
        number(value.updatedAt) &&
        record(value.values) &&
        Object.values(value.values).every((v) => string(v) || number(v) || boolean(v))
    );
}

function file(value: unknown): boolean {
    return (
        record(value) &&
        string(value.name) &&
        nonempty(value.ref) &&
        optional(value.type, string) &&
        optional(value.size, number)
    );
}

function event(value: unknown): boolean {
    return (
        record(value) &&
        nonempty(value.id) &&
        string(value.text) &&
        record(value.author) &&
        string(value.author.id) &&
        optional(value.author.name, string) &&
        optional(value.author.bot, boolean) &&
        optional(value.channel, string) &&
        optional(value.thread, string) &&
        optional(value.channelName, string) &&
        optional(value.mentioned, boolean) &&
        optional(value.replyTo, string) &&
        optional(value.url, string) &&
        optional(value.at, number) &&
        optional(value.attachments, (v) => list(v, string)) &&
        optional(value.files, (v) => list(v, file))
    );
}

function state(value: unknown): value is State {
    return (
        record(value) &&
        optional(value.revision, nonempty) &&
        record(value.own) &&
        list(value.pending, event) &&
        optional(value.pendingAccounts, (v) => record(v) && Object.values(v).every(nonempty)) &&
        list(
            value.recent,
            (v) =>
                record(v) &&
                nonempty(v.id) &&
                (value.revision === undefined
                    ? optional(v.reference, nonempty)
                    : nonempty(v.reference)) &&
                string(v.author) &&
                optional(v.authenticatedAccount, nonempty) &&
                number(v.at) &&
                optional(v.channel, string) &&
                optional(v.thread, string) &&
                optional(v.files, (files) => list(files, file)),
        ) &&
        record(value.replies) &&
        Object.values(value.replies).every(
            (v) =>
                record(v) &&
                number(v.at) &&
                optional(v.id, string) &&
                optional(v.sending, boolean) &&
                optional(v.retired, boolean),
        ) &&
        record(value.authors) &&
        Object.values(value.authors).every((v) => list(v, number)) &&
        count(value.delivered) &&
        count(value.dropped) &&
        optional(value.lastError, string) &&
        optional(value.lastErrorAt, number) &&
        optional(value.lastEventAt, number) &&
        optional(value.fatal, string)
    );
}

function load<T>(
    folder: string,
    name: string,
    valid: (v: unknown, id: string) => v is T,
): Record<string, T> | undefined {
    const path = join(folder, name);
    const problem = `Cannot recover relay ${name}. Restore the relay files and reload Relay.`;
    let stat;

    try {
        stat = lstatSync(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return undefined;
        }

        throw new Error(problem);
    }

    try {
        if (stat.isFile()) {
            const text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path));
            const value: unknown = JSON.parse(text);

            if (
                record(value) &&
                value.version === 1 &&
                record(value.connectors) &&
                Object.entries(value.connectors).every(([id, item]) => valid(item, id))
            ) {
                return value.connectors as Record<string, T>;
            }
        }
    } catch {
        // A parser error can include credentials from the file. Do not log it.
    }

    throw new Error(problem);
}

export function recoverRelay(folder: string): {
    configs: Record<string, ConnectorConfig>;
    states: Record<string, State>;
} {
    const configs = load(folder, "connectors.json", config);
    const states = load(folder, "state.json", state);

    if (configs === undefined && states === undefined) {
        return { configs: {}, states: {} };
    }

    if (
        configs === undefined ||
        states === undefined ||
        Object.keys(configs).length !== Object.keys(states).length ||
        Object.keys(configs).some((id) => !Object.hasOwn(states, id))
    ) {
        throw new Error("The relay files are incomplete. Restore both files and reload Relay.");
    }

    if (Object.values(configs).some((config) => config.revision !== states[config.id]!.revision)) {
        throw new Error(
            "The saved relay revisions do not match. Restore both files and reload Relay.",
        );
    }

    return { configs, states };
}
