// The kiwi schema travels in the file: it is read as data, and the message is interpreted,
// never compiled.
import { quoted } from "../fence.ts";

export type Obj = Record<string, unknown>;

// A native type's code in a schema is `~index` in this list.
const NATIVE = ["bool", "byte", "int", "uint", "float", "string", "int64", "uint64"] as const;

const KINDS = ["ENUM", "STRUCT", "MESSAGE"] as const;

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

export type FigKind = (typeof KINDS)[number];

export interface FigLimits {
    file: number;
    /** Bytes after decompression, for the whole file. */
    raw: number;
    /** Every field, list element, and byte array counts. */
    values: number;
    /** The longest list. */
    nodes: number;
    chars: number;
    depth: number;
    ms: number;
    entries: number;
}

// The value limit is a memory limit: a value costs 45 to 70 bytes, so 1 500 000 are about 100 MB of
// the scan worker's 256 MB (`WORKER.heapMb` in `scan.ts`). The 274 KB fixture uses about half.
export const FIG_LIMITS: FigLimits = {
    file: 20_000_000,
    raw: 100_000_000,
    values: 1_500_000,
    nodes: 500_000,
    chars: 65_536,
    depth: 32,
    ms: 5000,
    entries: 4000,
};

export class FigError extends Error {
    constructor(reason: string) {
        super(reason);
        this.name = "FigError";
    }
}

export function fail(reason: string): never {
    throw new FigError(reason);
}

export interface FigField {
    name: string;
    type: string;
    array: boolean;
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

// One budget for the schema and the data together.
export interface Budget {
    limits: FigLimits;
    started: number;
    values: number;
    /** Definitions decoded: a struct with no fields costs no byte, so it has a bound of its own. */
    decoded: number;
}

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

    // Every decode path passes here, so the count and the time hold on all of them.
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

    // Zigzag: the low bit is the sign.
    varInt(): number {
        const value = this.varUint() | 0;

        return value & 1 ? ~(value >>> 1) : value >>> 1;
    }

    // A number when it is exact, else its digits.
    varUint64(): number | string {
        const value = this.bigUint();

        return value <= MAX_SAFE ? Number(value) : value.toString();
    }

    varInt64(): number | string {
        const zigzag = this.bigUint();
        const value = (zigzag >> BigInt(1)) ^ -(zigzag & BigInt(1));

        return value <= MAX_SAFE && value >= -MAX_SAFE ? Number(value) : value.toString();
    }

    bigUint(): bigint {
        let value = BigInt(0);
        let shift = BigInt(0);
        let byte = 0;

        do {
            byte = this.byte();
            value |= BigInt(byte & 127) << shift;
            shift += BigInt(7);
        } while (byte & 128 && shift < BigInt(70));

        return value;
    }

    // kiwi writes 0 as one zero byte, and any other float as 4 bytes with the bits rotated.
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

// A field of an enum type keeps the enum's name: its value decodes to `VARIABLE`, not `28`.
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

// A field of one of these names would change the decoded object's prototype.
const UNSAFE = new Set(["__proto__", "constructor", "prototype"]);

// What a tiny file may decode before its bytes pay for it.
const DECODED_FLOOR = 64;

function decodeDef(cursor: Cursor, schema: FigSchema, def: FigDef, depth: number): Obj {
    const limits = cursor.budget.limits;

    if (depth > limits.depth) {
        fail(`its data nests deeper than ${limits.depth} levels`);
    }

    // A struct with no fields takes no byte, so the definitions are held to the bytes read so far:
    // empty structs cannot grow without bound, and padding buys nothing (2.5 MB made 2.5M objects).
    cursor.spend();

    const decoded = (cursor.budget.decoded += 1);
    const paid = Math.max(DECODED_FLOOR, cursor.at);

    if (decoded > paid) {
        fail(
            `its data asks for more values than the bytes it has read (${paid}) can hold, so it is not a Figma file`,
        );
    }

    // No prototype: a node could inherit a `type` from it.
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
            return cursor.varInt64();
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

// A value that the schema does not name stays a number, so a file of a newer Figma still reads.
function enumValue(cursor: Cursor, def: FigDef): string | number {
    const value = cursor.varUint();

    return def.fields.find((field) => field.tag === value)?.name ?? value;
}

// Figma names the root `Message`; else it is the last message, where kiwi puts the top of a file.
export function rootOf(schema: FigSchema): FigDef | undefined {
    return (
        schema.byName.get("Message") ??
        [...schema.defs].reverse().find((def) => def.kind === "MESSAGE")
    );
}

export function readMessage(schema: FigSchema, bytes: Buffer, budget: Budget): Obj {
    const root = rootOf(schema);

    if (root === undefined) {
        fail("its schema has no message to read");
    }

    const cursor = new Cursor(bytes, budget);

    return decodeDef(cursor, schema, root!, 0);
}
