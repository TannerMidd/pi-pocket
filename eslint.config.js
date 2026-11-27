import { readFileSync } from "node:fs";
import stylistic from "@stylistic/eslint-plugin";
import prettier from "eslint-config-prettier/flat";
import tseslint from "typescript-eslint";

// Host file access is structural (docs/design/sandbox-v2.md, 4.2): `node:fs`, `node:fs/promises`, and
// `node:child_process` are imported only by hostfs.ts, the named spawn wrappers, and the files that touch only Pocket's own
// data, install, config, or system locations. The list is `src/server/fs-census.json`; test/fs-census.test.ts keeps it
// current. Everything else goes through `hostfs` (a session's folder is a `FolderRef`).
const census = JSON.parse(
    readFileSync(new URL("./src/server/fs-census.json", import.meta.url), "utf8"),
);
const allowed = Object.entries(census.files)
    .filter(([, entry]) => ["own", "wrapper", "hostfs"].includes(entry.verdict))
    .map(([file]) => `src/server/${file}`);
const PRIMITIVES = ["fs", "fs/promises", "child_process"].flatMap((name) => [name, `node:${name}`]);
const PRIMITIVE = `^(${PRIMITIVES.map((name) => name.replace("/", "\\/")).join("|")})$`;
const HOSTFS =
    "Host code touches the file system through hostfs.ts (a session's folder is a FolderRef) or a named spawn wrapper. A file that touches only Pocket's own data goes in src/server/fs-census.json as `own`.";

// Layout only: Prettier formats, and these rules give the code room to breathe.
export default [
    {
        ignores: ["node_modules/**", "data/**", "docs-site/dist/**", "docs-site/.astro/**"],
    },
    {
        files: ["**/*.ts"],
        languageOptions: {
            parser: tseslint.parser,
        },
    },
    prettier,
    {
        files: ["**/*.{js,mjs,cjs,ts}"],
        plugins: {
            "@stylistic": stylistic,
        },
        rules: {
            curly: ["error", "all"],
            "@stylistic/padding-line-between-statements": [
                "error",
                { blankLine: "always", prev: "directive", next: "*" },
                { blankLine: "any", prev: "directive", next: "directive" },
                { blankLine: "always", prev: ["const", "let", "var"], next: "*" },
                {
                    blankLine: "any",
                    prev: ["const", "let", "var"],
                    next: ["const", "let", "var"],
                },
                {
                    blankLine: "always",
                    prev: "*",
                    next: ["block-like", "return", "throw"],
                },
                { blankLine: "always", prev: "block-like", next: "*" },
            ],
        },
    },
    {
        files: ["src/server/**/*.ts"],
        ignores: allowed,
        rules: {
            "no-restricted-imports": [
                "error",
                { paths: PRIMITIVES.map((name) => ({ name, message: HOSTFS })) },
            ],
            "no-restricted-syntax": [
                "error",
                {
                    selector: `ImportExpression[source.value=/${PRIMITIVE}/]`,
                    message: HOSTFS,
                },
                {
                    selector: `CallExpression[callee.name='require'][arguments.0.value=/${PRIMITIVE}/]`,
                    message: HOSTFS,
                },
                {
                    selector:
                        "MemberExpression[object.name='process'][property.name='getBuiltinModule']",
                    message: HOSTFS,
                },
            ],
        },
    },
];
