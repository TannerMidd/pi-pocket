// The expressions of a surface (`src/server/surfaces/`): pure, no DOM, no imports. The browser runs them for the live
// display and the server for validation, an action's context, and the text form: one file, so both agree.
//
// A value is a literal, `{ "@path": "/rows/0/size" }` (RFC 6901; inside a table row a path with no leading `/` is
// relative to the row), or `{ "@call": "fn", "args": {...} }` for one of a closed set of pure functions. No `eval`, no
// loops, no user functions. `/$/name` reads a computed value.

export const MAX_DEPTH = 6;
/** The most items a list function walks: a surface holds at most this many in a list. */
export const MAX_ITEMS = 500;

const CALLS = new Set([
    "sum",
    "count",
    "pick",
    "bytes",
    "formatString",
    "pluralize",
    "eq",
    "gt",
    "not",
    "and",
    "or",
]);

/** The names of the functions an expression may call. */
export const FUNCTIONS = [...CALLS];

const UNITS = ["B", "kB", "MB", "GB", "TB", "PB"];

function isObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a value is an expression (a path or a call) and not a literal. */
export function isExpr(value) {
    return isObject(value) && ("@path" in value || "@call" in value);
}

/** An RFC 6901 pointer as its parts, or undefined when it is not one. */
export function pointer(path) {
    if (typeof path !== "string") {
        return undefined;
    }

    if (path === "" || path === "/") {
        return [];
    }

    return path
        .replace(/^\//, "")
        .split("/")
        .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/** What a path reads: `/$/name` a computed value, `/x/y` the data, `x` a field of the row. Undefined when absent. */
export function readPath(path, scope) {
    const parts = pointer(path);

    if (parts === undefined) {
        return undefined;
    }

    let at;
    let rest = parts;

    if (typeof path === "string" && path.startsWith("/$/")) {
        at = scope.computed ?? {};
        rest = parts.slice(1);
    } else if (typeof path === "string" && path.startsWith("/")) {
        at = scope.data;
    } else {
        at = scope.row;
    }

    for (const part of rest) {
        if (Array.isArray(at)) {
            at = /^(0|[1-9]\d*)$/.test(part) ? at[Number(part)] : undefined;
        } else if (isObject(at) && Object.hasOwn(at, part)) {
            at = at[part];
        } else {
            return undefined;
        }
    }

    return at;
}

/** A list argument: a path string, or a path expression, read from the scope. Always an array, never more than `MAX_ITEMS`. */
function listOf(value, scope) {
    const path = isObject(value) && "@path" in value ? value["@path"] : value;
    const list = typeof path === "string" ? readPath(path, scope) : undefined;

    return Array.isArray(list) ? list.slice(0, MAX_ITEMS) : [];
}

/** A row's field by name, or by a dotted path: `picked`, `size`. */
function field(row, name) {
    if (typeof name !== "string" || name === "") {
        return row;
    }

    let at = row;

    for (const part of name.split(".")) {
        if (isObject(at) && Object.hasOwn(at, part)) {
            at = at[part];
        } else {
            return undefined;
        }
    }

    return at;
}

/** A row passes `where`: a field that is truthy, or `!field`; no `where` passes every row. */
function passes(row, where) {
    if (typeof where !== "string" || where === "") {
        return true;
    }

    const negated = where.startsWith("!");

    return negated ? !field(row, where.slice(1)) : Boolean(field(row, where));
}

/** A number, or 0: a sum or a size never throws on a field that is not one. */
function numberOf(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** `4200000000` as `4.2 GB`: decimal units, one decimal place above bytes. */
export function bytes(value) {
    let size = Math.max(0, numberOf(value));
    let at = 0;

    while (size >= 1000 && at < UNITS.length - 1) {
        size /= 1000;
        at += 1;
    }

    return at === 0
        ? `${Math.round(size)} B`
        : `${(Math.round(size * 10) / 10).toFixed(1)} ${UNITS[at]}`;
}

/** A value as text: strings and numbers as they are, nothing for null or undefined, JSON for the rest. */
export function textOf(value) {
    if (value === undefined || value === null) {
        return "";
    }

    return typeof value === "string"
        ? value
        : typeof value === "object"
          ? JSON.stringify(value)
          : String(value);
}

function call(name, args, scope, depth) {
    const arg = (key) => evaluate(args[key], scope, depth + 1);

    switch (name) {
        case "sum": {
            return listOf(args.list, scope)
                .filter((row) => passes(row, args.where))
                .reduce((total, row) => total + numberOf(field(row, args.field)), 0);
        }

        case "count": {
            return listOf(args.list, scope).filter((row) => passes(row, args.where)).length;
        }

        case "pick": {
            return listOf(args.list, scope)
                .filter((row) => passes(row, args.where))
                .map((row) => field(row, args.field))
                .filter((value) => value !== undefined);
        }

        case "bytes": {
            return bytes(arg("value"));
        }

        case "formatString": {
            const template = textOf(arg("value"));

            return template.replace(/\$\{([^}]*)\}/g, (_, path) =>
                textOf(readPath(path.trim(), scope)),
            );
        }

        case "pluralize": {
            const count = numberOf(arg("count"));

            return textOf(count === 1 ? arg("one") : arg("other"));
        }

        case "eq": {
            return JSON.stringify(arg("a")) === JSON.stringify(arg("b"));
        }

        case "gt": {
            return numberOf(arg("a")) > numberOf(arg("b"));
        }

        case "not": {
            return !arg("value");
        }

        case "and":

        case "or": {
            const values = Array.isArray(args.values) ? args.values : [args.a, args.b];
            const results = values.map((each) => Boolean(evaluate(each, scope, depth + 1)));

            return name === "and" ? results.every(Boolean) : results.some(Boolean);
        }

        default: {
            return undefined;
        }
    }
}

/**
 * The value of an expression in a scope `{ data, computed?, row? }`. A literal is itself. Too deep, an unknown
 * function, and a missing path give undefined, never an exception: the validator refuses them before they are stored.
 */
export function evaluate(value, scope, depth = 0) {
    if (!isExpr(value)) {
        return value;
    }

    if (depth >= MAX_DEPTH) {
        return undefined;
    }

    if ("@path" in value) {
        return readPath(value["@path"], scope);
    }

    const name = value["@call"];

    if (typeof name !== "string" || !CALLS.has(name)) {
        return undefined;
    }

    return call(name, isObject(value.args) ? value.args : {}, scope, depth);
}

/** The computed values of a surface, in order: each may read the ones before it as `/$/name`. */
export function evaluateComputed(computed, data) {
    const scope = { data, computed: Object.create(null) };

    for (const [name, expr] of Object.entries(computed ?? {})) {
        scope.computed[name] = evaluate(expr, scope);
    }

    return scope.computed;
}

/**
 * Why an expression is not valid, or undefined: a closed set of functions, at most `MAX_DEPTH` deep, paths that are
 * strings. `where` is a field name, never code.
 */
export function checkExpr(value, depth = 0) {
    if (Array.isArray(value)) {
        return value
            .map((each) => checkExpr(each, depth + 1))
            .find((problem) => problem !== undefined);
    }

    if (!isExpr(value)) {
        return undefined;
    }

    if (depth >= MAX_DEPTH) {
        return "an expression nests too deep";
    }

    if ("@path" in value) {
        return typeof value["@path"] === "string" && pointer(value["@path"]) !== undefined
            ? undefined
            : "@path needs a path string";
    }

    if (typeof value["@call"] !== "string" || !CALLS.has(value["@call"])) {
        return `unknown function ${JSON.stringify(value["@call"])}`;
    }

    const args = value.args ?? {};

    if (!isObject(args)) {
        return "args must be an object";
    }

    for (const each of Object.values(args)) {
        const problem = checkExpr(each, depth + 1);

        if (problem !== undefined) {
            return problem;
        }
    }

    for (const key of ["list"]) {
        if (key in args && !isExpr(args[key]) && typeof args[key] !== "string") {
            return `${key} must be a path`;
        }
    }

    return undefined;
}
