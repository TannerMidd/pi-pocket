// Checks `types/pocket.d.ts` itself, in `npm run check`. `tsc -p .` skips declaration files (`skipLibCheck`), where a
// name that does not resolve reads as `any`: `public-types.ts` would then prove nothing. This checks that one file alone,
// without the packages' own declarations, which have errors of their own.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("..", import.meta.url));
const file = join(root, "types", "pocket.d.ts");
const config = ts.getParsedCommandLineOfConfigFile(
    join(root, "tsconfig.json"),
    { skipLibCheck: false },
    { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} },
);

if (config === undefined) {
    throw new Error("tsconfig.json cannot be read");
}

const program = ts.createProgram([file], config.options);
const source = program.getSourceFile(file)!;
const problems = [
    ...program.getSyntacticDiagnostics(source),
    ...program.getSemanticDiagnostics(source),
];

if (problems.length > 0) {
    process.stderr.write(
        ts.formatDiagnostics(problems, {
            getCanonicalFileName: (name) => name,
            getCurrentDirectory: () => root,
            getNewLine: () => "\n",
        }),
    );
    process.exitCode = 1;
}
