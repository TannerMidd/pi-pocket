// The copy sheet's choices (`sheets/copy.js`): where a copy of a session runs (computer and folder), with which model
// and thinking level, in a worktree or not, and an edited message. They outlive the sheet while the folder picker or
// the model picker is open over it (each in a choose mode that returns here), and go when the last sheet closes.
import { useEffect, useState } from "preact/hooks";
import { store } from "./store.js";

/** Every thinking level, lowest first, as the server names them (`models.ts` `THINKING_LEVELS`). */
const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** The choices of the copy sheet open now, or null. `key` names the copy: its session and message. */
let draft = null;
const listeners = new Set();

store.subscribe(({ sheet }) => {
    if (!sheet) {
        draft = null;
    }
});

/** The choices now, for the pickers. */
export const copyDraft = () => draft;

/** Change the choices: the copy sheet shows them when it is back. */
export function updateDraft(change) {
    if (draft === null) {
        return;
    }

    draft = { ...draft, ...change };

    for (const listener of listeners) {
        listener();
    }
}

/**
 * The choices for the copy `key`: kept ones when a picker over the sheet returns, else new ones from `init`. A sheet
 * that is closing makes none: nothing is kept after it.
 */
export function useCopyDraft(key, init) {
    const [, setTick] = useState(0);

    useEffect(() => {
        const listener = () => setTick((n) => n + 1);

        listeners.add(listener);

        return () => listeners.delete(listener);
    }, []);

    if (draft?.key === key) {
        return draft;
    }

    const fresh = { key, ...init() };

    if (store.state.sheet) {
        draft = fresh;
    }

    return fresh;
}

/** A model in the app's list, by the reference a session keeps (`{ provider, modelId }`). */
export const modelOf = (ref) =>
    ref
        ? store.state.models.find(
              (model) => model.provider === ref.provider && model.id === ref.modelId,
          )
        : undefined;

/**
 * The level `model` thinks at when `level` is asked, as the server sets it (`models.ts` `levelFor`): `level` itself,
 * else its nearest lower one, else its lowest.
 */
export function levelFor(model, level) {
    const supported = model?.levels ?? ["off"];
    const below = LEVELS.slice(0, LEVELS.indexOf(level) + 1).reverse();

    return below.find((each) => supported.includes(each)) ?? supported[0] ?? "off";
}

/** The model picker chose a model for the copy: its thinking level becomes one the model has. */
export function chooseModel(model) {
    const ref = { provider: model.provider, modelId: model.id };

    updateDraft({ model: ref, thinkingLevel: levelFor(model, draft?.thinkingLevel ?? "off") });
}

/** The model picker chose a thinking level for the copy. */
export const chooseLevel = (level) => updateDraft({ thinkingLevel: level });

/** The folder picker chose a folder for the copy. */
export const chooseFolder = (cwd) => updateDraft({ cwd, reason: "picked", picked: cwd });
