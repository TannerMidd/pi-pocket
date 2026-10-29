/**
 * A Figma `.fig` file's kiwi schema and message, decoded offline (design system scan). The schema travels inside the file, so
 * a decode needs no Figma account, token, or network: the schema is read as data, and the message is walked by an
 * interpreter, never compiled.
 *
 * Everything is bounded: the values, strings, arrays and nodes read, the nesting, and the time. A string of the file that a
 * reason repeats is quoted, one line, and 60 characters at most, so a name cannot break the report's fence. A file this
 * module cannot read throws `FigError` with a reason for a person; `scan-fig.ts` turns that into a note and the scan goes on.
 */
import { quoted } from "../fence.ts";

export type Obj = Record<string, unknown>;

/** The types a schema field can name, by their code in the schema: `~code` is the place in this list. */
const NATIVE = ["bool", "byte", "int", "uint", "float", "string", "int64", "uint64"] as const;

/** The kinds of definition, by their code in the schema. */
const KINDS = ["ENUM", "STRUCT", "MESSAGE"] as const;

export type FigKind = (typeof KINDS)[number];

export interface FigLimits {
    /** Bytes read from the file. */
    file: number;
    /** Bytes in all, after decompression. */
    raw: number;
    /** Values decoded: every field, every array element, and every byte array counts. */
    values: number;
    /** Nodes in the file's `nodeChanges`. */
    nodes: number;
    /** Characters in one string. */
    chars: number;
    /** Nesting of definitions. */
    depth: number;
    /** Milliseconds for one file. */
    ms: number;
    /** Entries in a ZIP's central directory. */
    entries: number;
}

export const FIG_LIMITS: FigLimits = {
    file: 20_000_000,
    raw: 100_000_000,
    values: 5_000_000,
    nodes: 500_000,
    chars: 65_536,
    depth: 32,
    ms: 5000,
    entries: 4000,
};

/** A file that cannot be read, with the reason a person needs. */
export class FigError extends Error {
    constructor(reason: string) {
        super(reason);
        this.name = "FigError";
    }
}

/** Stops the read with a reason for a person: a file that the scan cannot take. */
export function fail(reason: string): never {
    throw new FigError(reason);
}

// --- The schema -----------------------------------------------------------------------------------------------------

export interface FigField {
    name: string;
    /** A native type (`uint`), a definition's name, or `enum`. */
    type: string;
    array: boolean;
    /** The field's tag in a message. */
    tag: number;
}

export interface FigDef {
    name: string;
    kind: FigKind;
    fields: FigField[];
}

export interface FigSchema {
    defs: FigDef[];
    byName: Map<string, FigDef>;
}

/** How much of a file one read may use: one counter for the schema and the data together. */
export interface Budget {
    limits: FigLimits;
    started: number;
    values: number;
    /** Definitions decoded: a struct with no fields costs no byte, so this count has a bound of its own. */
    decoded: number;
}

/** A reader over one buffer: every read is checked against what is left, and each value counts against the budget. */
class Cursor {
    bytes: Buffer;
    at = 0;
    budget: Budget;

    constructor(bytes: Buffer, budget: Budget) {
        this.bytes = bytes;
        this.budget = budget;
    }

    get left(): number {
        return this.bytes.length - this.at;
    }

    /** One value read: the time and the count are checked here, so every decode path passes through it. */
    spend(values = 1): void {
        const budget = this.budget;

        budget.values += values;

        if (budget.values > budget.limits.values) {
            fail(
                `it holds more than ${budget.limits.values} values, which is more than a design system needs`,
            );
        }

        if (budget.values % 4096 < values && Date.now() - budget.started > budget.limits.ms) {
            fail(
                `reading the Figma files took longer than ${Math.round(budget.limits.ms / 1000)} seconds`,
            );
        }
    }

    byte(): number {
        if (this.at >= this.bytes.length) {
            fail("it ends in the middle of a value");
        }

        this.spend();

        return this.bytes[this.at++]!;
    }

    take(length: number): Buffer {
        if (length < 0 || length > this.left) {
            fail(`a value claims ${length} bytes, more than the ${this.left} left in the file`);
        }

        const slice = this.bytes.subarray(this.at, this.at + length);

        this.at += length;

        return slice;
    }

    /** A variable-length unsigned integer: 7 bits a byte, the top bit says another byte follows. */
    varUint(): number {
        let value = 0;
        let shift = 0;
        let byte = 0;

        do {
            byte = this.byte();
            value |= (byte & 127) << shift;
            shift += 7;
        } while (byte & 128 && shift < 35);

        return value >>> 0;
    }

    /** A signed integer, zigzag-encoded: the low bit is the sign. */
    varInt(): number {
        const value = this.varUint() | 0;

        return value & 1 ? ~(value >>> 1) : value >>> 1;
    }

    /** An unsigned 64-bit integer: a number when it fits, else its digits. */
    varUint64(): number | string {
        let value = BigInt(0);
        let shift = BigInt(0);
        let byte = 0;

        do {
            byte = this.byte();
            value |= BigInt(byte & 127) << shift;
            shift += BigInt(7);
        } while (byte & 128 && shift < BigInt(70));

        return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
    }

    /** A float, in the compressed form kiwi writes: one zero byte is 0, else 4 bytes with the bits rotated. */
    varFloat(): number {
        const first = this.bytes[this.at];

        if (first === undefined) {
            fail("it ends in the middle of a number");
        }

        this.spend();

        if (first === 0) {
            this.at += 1;

            return 0;
        }

        const four = this.take(4);
        const rotated = (four[0]! | (four[1]! << 8) | (four[2]! << 16) | (four[3]! << 24)) >>> 0;
        const bits = ((rotated << 23) | (rotated >>> 9)) >>> 0;
        const view = new DataView(new ArrayBuffer(4));

        view.setUint32(0, bits, true);

        return view.getFloat32(0, true);
    }

    /** A string: UTF-8 up to a NUL, with a ceiling on its length. */
    string(): string {
        const start = this.at;

        while (this.at < this.bytes.length && this.bytes[this.at] !== 0) {
            this.at += 1;

            if (this.at - start > this.budget.limits.chars) {
                fail(`it holds a text longer than ${this.budget.limits.chars} characters`);
            }
        }

        if (this.at >= this.bytes.length) {
            fail("it ends in the middle of a text");
        }

        const text = this.bytes.subarray(start, this.at).toString("utf8");

        this.at += 1;
        this.spend();

        return text;
    }
}

/**
 * The schema a file carries: its definitions, and the fields of each, with their types resolved by name. A field of an enum
 * type is named by its enum's definition, so its value decodes to the name that Figma gives it (`VARIABLE`, not `28`).
 */
export function readSchema(bytes: Buffer, budget: Budget): FigSchema {
    const cursor = new Cursor(bytes, budget);
    const count = cursor.varUint();

    if (count > 12_000) {
        fail(`its schema claims ${count} definitions, which is not a schema`);
    }

    const defs: FigDef[] = [];

    for (let index = 0; index < count; index++) {
        const name = cursor.string();
        const kindCode = cursor.byte();
        const kind = KINDS[kindCode];

        if (kind === undefined) {
            fail(`its schema has a definition of an unknown kind (${kindCode})`);
        }

        const fieldCount = cursor.varUint();

        if (fieldCount > 2000) {
            fail(
                `its schema gives ${quoted(name, 60)} ${fieldCount} fields, which is not a definition`,
            );
        }

        const fields: FigField[] = [];

        for (let field = 0; field < fieldCount; field++) {
            const fieldName = cursor.string();
            const code = cursor.varInt();
            const array = (cursor.byte() & 1) === 1;
            const tag = cursor.varUint();

            fields.push({ name: fieldName, type: String(code), array, tag });
        }

        defs.push({ name, kind, fields });
    }

    const byName = new Map(defs.map((def) => [def.name, def]));

    for (const def of defs) {
        for (const field of def.fields) {
            const code = Number(field.type);

            if (def.kind === "ENUM") {
                field.type = "uint";

                continue;
            }

            if (code < 0) {
                const native = NATIVE[~code];

                if (native === undefined) {
                    fail(`its schema names an unknown type (${code})`);
                }

                field.type = native;

                continue;
            }

            const target = defs[code];

            if (target === undefined) {
                fail(`its schema names a definition that is not in it (${code})`);
            }

            field.type = target.name;
        }
    }

    return { defs, byName };
}

// --- The message ----------------------------------------------------------------------------------------------------

/** A field's name that must not become a key of a decoded object: it would change the object's prototype. */
const UNSAFE = new Set(["__proto__", "constructor", "prototype"]);

/** The definitions a read may decode before its data has paid for any: a tiny file has a floor of its own. */
const DECODED_FLOOR = 64;

/** One message decoded by the schema: messages read tagged fields, structs read their fields in order. */
function decodeDef(cursor: Cursor, schema: FigSchema, def: FigDef, depth: number): Obj {
    const limits = cursor.budget.limits;

    if (depth > limits.depth) {
        fail(`its data nests deeper than ${limits.depth} levels`);
    }

    // A definition is a value, however few bytes it takes. A struct with no fields takes none, so the count is held to the
    // bytes of the data that the message has read so far: padding at the end of a chunk buys nothing (a 3 KB file padded to
    // 2.5 MB made 2.5 million empty objects), and a file cannot ask for a tree of empty structs that grows without bound (the
    // time check would never run either).
    cursor.spend();

    const decoded = (cursor.budget.decoded += 1);
    const paid = Math.max(DECODED_FLOOR, cursor.at);

    if (decoded > paid) {
        fail(
            `its data asks for more values than the bytes it has read (${paid}) can hold, so it is not a Figma file`,
        );
    }

    // A key from the file must never become the object's prototype: a node could inherit a `type` from it.
    const out: Obj = Object.create(null) as Obj;

    if (def.kind !== "MESSAGE") {
        for (const field of def.fields) {
            const value = readField(cursor, schema, field, depth);

            if (!UNSAFE.has(field.name)) {
                out[field.name] = value;
            }
        }

        return out;
    }

    const byTag = new Map(def.fields.map((field) => [field.tag, field]));

    for (;;) {
        const tag = cursor.varUint();

        if (tag === 0) {
            return out;
        }

        const field = byTag.get(tag);

        if (field === undefined) {
            fail(`its data holds a field (${tag}) that its schema does not name`);
        }

        const value = readField(cursor, schema, field, depth);

        if (!UNSAFE.has(field.name)) {
            out[field.name] = value;
        }
    }
}

function readField(cursor: Cursor, schema: FigSchema, field: FigField, depth: number): unknown {
    if (!field.array) {
        return readValue(cursor, schema, field.type, depth);
    }

    if (field.type === "byte") {
        const length = cursor.varUint();

        cursor.spend();

        return cursor.take(length);
    }

    const length = cursor.varUint();

    if (length > cursor.budget.limits.nodes) {
        fail(`its data claims a list of ${length} values, which is too many`);
    }

    cursor.spend(length);

    const values: unknown[] = [];

    for (let index = 0; index < length; index++) {
        values.push(readValue(cursor, schema, field.type, depth));
    }

    return values;
}

function readValue(cursor: Cursor, schema: FigSchema, type: string, depth: number): unknown {
    switch (type) {
        case "bool":
            return cursor.byte() !== 0;
        case "byte":
            return cursor.byte();
        case "int":
            return cursor.varInt();
        case "uint":
            return cursor.varUint();
        case "float":
            return cursor.varFloat();
        case "string":
            return cursor.string();
        case "int64":
        case "uint64":
            return cursor.varUint64();

        default: {
            const def = schema.byName.get(type);

            if (def === undefined) {
                return fail(`its schema names a type that is not in it (${quoted(type, 60)})`);
            }

            return def.kind === "ENUM"
                ? enumValue(cursor, def)
                : decodeDef(cursor, schema, def, depth + 1);
        }
    }
}

/**
 * An enum's value as the name the schema gives it, or as the number when the schema does not hold that value: a file is
 * read the way Figma reads it, where `type` is `VARIABLE` and not 28. The name is the schema's own string, so no string is
 * made for each value.
 */
function enumValue(cursor: Cursor, def: FigDef): string | number {
    const value = cursor.varUint();

    return def.fields.find((field) => field.tag === value)?.name ?? value;
}

/**
 * The root of a schema: Figma names it `Message`, and a schema that does not is read from its last message, where kiwi puts
 * the top of a file.
 */
export function rootOf(schema: FigSchema): FigDef | undefined {
    return (
        schema.byName.get("Message") ??
        [...schema.defs].reverse().find((def) => def.kind === "MESSAGE")
    );
}

/** The message a file's data chunk holds, read by the file's own schema. */
export function readMessage(schema: FigSchema, bytes: Buffer, budget: Budget): Obj {
    const root = rootOf(schema);

    if (root === undefined) {
        fail("its schema has no message to read");
    }

    const cursor = new Cursor(bytes, budget);

    return decodeDef(cursor, schema, root!, 0);
}
