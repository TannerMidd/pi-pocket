// A copy sheet sends its worktree choice for either computer, not only for this server.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

const STUBS: Record<string, string> = {
    "preact/hooks": `export const useEffect = () => {}; export const useState = () => {};`,
    "../copy-draft.js": `export const chooseFolder = () => {}; export const copyDraft = () => {}; export const modelOf = () => {}; export const updateDraft = () => {}; export const useCopyDraft = () => {};`,
    "../folder-paths.js": `export const shortPath = () => {};`,
    "../runner-wait.js": `export const waitOnComputer = () => {};`,
    "../store.js": `export const actions = {}; export const api = () => {}; export const attempt = () => {}; export const canSteer = () => {}; export const closeSheet = () => {}; export const navigate = () => {}; export const notify = () => {}; export const openSheet = () => {}; export const scoped = () => {}; export const store = {};`,
    "../ui.js": `export const html = () => {}; export const Icon = () => {}; export const Sheet = () => {}; export const Switch = () => {};`,
};
const hooks = registerHooks({
    resolve(specifier, context, next) {
        const stub = STUBS[specifier];

        return stub !== undefined && context.parentURL?.endsWith("/web/sheets/copy.js")
            ? { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true }
            : next(specifier, context);
    },
});
const { placeOf } = (await import(new URL("../web/sheets/copy.js", import.meta.url).href)) as {
    placeOf(draft: Record<string, unknown>): Record<string, unknown> | undefined;
};

hooks.deregister();

for (const runner of [null, "computer"]) {
    test(`the copy sheet sends a worktree choice on ${runner ?? "this server"}`, () => {
        const source = { runner, cwd: "/repo" };
        const draft = { source, runner, cwd: source.cwd };

        assert.equal(placeOf({ ...draft, worktree: false }), undefined);
        assert.deepEqual(placeOf({ ...draft, worktree: true }), { worktree: true });
    });
}
