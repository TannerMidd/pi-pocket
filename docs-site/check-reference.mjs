// The docs build's reference check, alone, for the root `npm run check`: each member in types/pocket.d.ts and its
// reference page must give the same Since line. It needs only TypeScript, which Pi Pocket's own packages have, so it
// runs without the site's dependencies.
import { fileURLToPath } from "node:url";
import { checkReference } from "./src/reference-check.mjs";

const errors = checkReference(fileURLToPath(new URL("..", import.meta.url)));

if (errors.length > 0) {
    process.stderr.write(`The reference and types/pocket.d.ts differ:\n${errors.join("\n")}\n`);
    process.exitCode = 1;
}
