/**
 * Which models a text names, so PiP passes a model, or names one in a task, only when its person named that model.
 * Words are compared, not characters: "GPT 5.1 Codex", "gpt-5.1-codex", and "gpt5.1 codex" name the same model, and
 * "auto" alone names none. Words that name a longer model name only that one: "gpt-5-nano" is not "gpt-5".
 */
import type { Api, Model } from "@earendil-works/pi-ai";

/** One written word: letters and digits, and dots between digits ("gpt5.1"). */
const WRITTEN = /(?:[\p{L}\p{N}]|(?<=\p{N})\.(?=\p{N}))+/gu;

/**
 * A text's lowercased words, split at anything not a letter or digit and where letters and digits meet ("GPT-5.1" is
 * gpt 5 1), and how each joins the word before it: "" inside one written word ("4o", "k3"), "." between the digits of
 * a version ("2.5"), and " " for anything else (a space, a dash).
 */
function split(text: string): { words: string[]; joins: string[] } {
    const words: string[] = [];
    const joins: string[] = [];

    for (const written of text.toLowerCase().match(WRITTEN) ?? []) {
        let join = " ";

        for (const part of written.match(/\p{L}+|\p{N}+|\./gu) ?? []) {
            if (part === ".") {
                join = ".";
            } else {
                words.push(part);
                joins.push(join);
                join = "";
            }
        }
    }

    return { words, joins };
}

/** A text's lowercased words, as `split` gives them. */
export function words(text: string): string[] {
    return split(text).words;
}

/**
 * A text read for matching: its words and how they join (`split`), which message each is in, and where each word is. A
 * phrase is looked up by its first word there, not sought at every word, so reading a text costs its length once, and
 * matching it costs the phrases and the places they could start, however long the text is. PiP reads its person's
 * words once per action.
 */
export type Indexed = {
    words: readonly string[];
    joins: readonly string[];
    messages: readonly number[];
    at: ReadonlyMap<string, readonly number[]>;
};

/** `text` read for matching: one message, or several, each apart. */
export function indexed(text: string | readonly string[]): Indexed {
    const words: string[] = [];
    const joins: string[] = [];
    const messages: number[] = [];
    const at = new Map<string, number[]>();

    (typeof text === "string" ? [text] : text).forEach((message, number) => {
        const part = split(message);

        part.words.forEach((word, index) => {
            const places = at.get(word);

            if (places === undefined) {
                at.set(word, [words.length]);
            } else {
                places.push(words.length);
            }

            words.push(word);
            joins.push(part.joins[index]!);
            messages.push(number);
        });
    });

    return { words, joins, messages, at };
}

const read = (text: string | Indexed): Indexed => (typeof text === "string" ? indexed(text) : text);

/**
 * Words that name a model; for a short name, also how they must be joined (`split`'s, the first one aside), and the
 * `family` word it needs in the same message.
 */
type Phrase = { words: readonly string[]; joins?: readonly string[]; family?: Phrase };

/**
 * Where `phrase` is a run of `text`'s words, in one message, joined as it says when it says, and not cut off in the
 * middle of a written word or a version ("zeta-5" in "zeta-5o" or "zeta-5.2"), with its family word in the same message
 * if it needs one: the index of its first word, each time.
 */
function starts(text: Indexed, phrase: Phrase): number[] {
    const length = phrase.words.length;

    if (length === 0) {
        return [];
    }

    // Where its first word is; the rest are compared there.
    const found = (text.at.get(phrase.words[0]!) ?? []).filter((start) => {
        const after = text.joins[start + length];

        return (
            start + length <= text.joins.length &&
            text.messages[start + length - 1] === text.messages[start] &&
            (after === undefined || after === " ") &&
            phrase.words.every(
                (word, offset) =>
                    offset === 0 ||
                    (text.words[start + offset] === word &&
                        (phrase.joins === undefined ||
                            text.joins[start + offset] === phrase.joins[offset])),
            )
        );
    });

    if (phrase.family === undefined || found.length === 0) {
        return found;
    }

    const kin = new Set(starts(text, phrase.family).map((place) => text.messages[place]));

    return found.filter((start) => kin.has(text.messages[start]));
}

/** Whether `phrase` is a run of `text`'s words. */
function contains(text: Indexed, phrase: Phrase): boolean {
    return starts(text, phrase).length > 0;
}

/** Spelled out enough to name a model: two words or more, one of them made of letters. "auto" or "4 5" is not. */
function distinct(phrase: Phrase): boolean {
    return phrase.words.length >= 2 && phrase.words.some((word) => /\p{L}/u.test(word));
}

/**
 * A model's id or name as people shorten it, without its first written word ("claude", "gpt", "kimi"), when what is
 * left is still a name of its own: a word of three letters or more first ("opus 4.5"), however it is written; or a word
 * that mixes letters and digits ("K3", "4o"), or a version and a word after it ("2.5 Flash"), written as the model
 * writes them. A bare number and a word ("5 mini" of gpt-5-mini) is said in ordinary text, "build 5 mini apps", and so
 * are "K-3" and "4 o'clock". So are two characters, a letter and a digit ("uuid v4", "my M3 laptop"): such a short name
 * counts only with the word it was shortened from, its family, in the same message ("Kiwi's K3", "kiwi: use K3").
 */
function shortened(full: string): Phrase | undefined {
    const { words, joins } = split(full);
    const from = joins.indexOf(" ", 1);

    if (from === -1) {
        return undefined;
    }

    const family = { words: words.slice(0, from), joins: joins.slice(0, from) };
    const rest = { words: words.slice(from), joins: joins.slice(from) };
    const next = rest.joins.indexOf(" ", 1);
    const first = rest.words.slice(0, next === -1 ? undefined : next);
    const letters = (word: string) => /\p{L}/u.test(word);

    if (/^\p{L}{3,}$/u.test(first[0]!)) {
        return { words: rest.words };
    }

    const mixed = first.some(letters) && !first.every(letters);
    const version =
        first.length > 1 &&
        !first.some(letters) &&
        rest.joins.slice(1, first.length).includes(".") &&
        rest.words.slice(first.length).some(letters);

    if (mixed && first.join("").length === 2) {
        return { ...rest, family };
    }

    return mixed || version ? rest : undefined;
}

/**
 * The phrases that name a model: its id, its name, and its provider with its id. `loosely` adds them as people
 * shorten them (`shortened`).
 */
function phrases(model: Model<Api>, loosely: boolean): Phrase[] {
    const all: Phrase[] = [model.id, model.name, `${model.provider} ${model.id}`].map((each) => ({
        words: words(each),
    }));

    if (loosely) {
        for (const full of [model.id, model.name]) {
            const short = shortened(full);

            if (short !== undefined) {
                all.push(short);
            }
        }
    }

    return all.filter(distinct);
}

const modelKey = (model: Model<Api>) => `${model.provider}/${model.id}`;

/** The words a person names a provider after, as the one to pay: "on GitHub Copilot", "via OpenRouter". */
const VIA = new Set(["on", "via", "through", "with", "using", "from"]);

/**
 * The models among `models` that `text` names, by the phrases above. Where a phrase of one model runs on into a longer
 * phrase of another, from the same word, the text names only the longer one: "gpt-5-nano" names gpt-5-nano, not gpt-5.
 * The models of `among` (every model Pi knows) take part in that too, so words that name a model not signed in do not
 * name a shorter one that is.
 */
export function modelsNamed(
    text: string | Indexed,
    models: readonly Model<Api>[],
    loosely = false,
    among: readonly Model<Api>[] = models,
): Model<Api>[] {
    const said = read(text);
    const all = [
        ...new Map([...among, ...models].map((model) => [modelKey(model), model])).values(),
    ];
    const found = all.map((model) =>
        phrases(model, loosely).flatMap((phrase) =>
            starts(said, phrase).map((start) => ({ start, length: phrase.words.length })),
        ),
    );
    // The most words any model's phrase takes from each word on.
    const longest = new Map<number, number>();

    for (const { start, length } of found.flat()) {
        longest.set(start, Math.max(longest.get(start) ?? 0, length));
    }

    const named = new Set(
        all
            .filter((_, index) =>
                found[index]!.some(({ start, length }) => length === longest.get(start)),
            )
            .map(modelKey),
    );

    return models.filter((model) => named.has(modelKey(model)));
}

const key = (phrase: Phrase) => `${phrase.words.join(" ")}|${phrase.joins?.join(",") ?? ""}`;

/** Whether a phrase in `text` names both `a` and `b`: the same model at two providers, as far as those words go. */
export function sharePhrase(text: string | Indexed, a: Model<Api>, b: Model<Api>): boolean {
    const said = read(text);
    const theirs = new Set(phrases(b, true).map(key));

    return phrases(a, true).some((phrase) => theirs.has(key(phrase)) && contains(said, phrase));
}

/**
 * Whether a person's `text` names `model`, as they would say it, among the `models` signed in: words that name a longer
 * one of them, or of `among` (every model Pi knows), do not name `model` ("gpt-5-nano" is not gpt-5). When the same
 * words name it at another provider too (Claude Opus 4.5 is at Anthropic and GitHub Copilot), the provider must be
 * named as well, by its whole id or name, right after one of `VIA` ("on GitHub Copilot"): which one pays is theirs to
 * say. One word of it is ordinary text, there too ("write it with Go"), and elsewhere ("go ahead").
 */
export function personNamed(
    text: string | Indexed,
    model: Model<Api>,
    models: readonly Model<Api>[],
    providerName: (provider: string) => string = (provider) => provider,
    among: readonly Model<Api>[] = models,
): boolean {
    const said = read(text);

    if (!modelsNamed(said, [model], true, [...models, ...among]).includes(model)) {
        return false;
    }

    const twins = models.filter(
        (other) => other.provider !== model.provider && sharePhrase(said, model, other),
    );

    if (twins.length === 0) {
        return true;
    }

    // Its whole id or name, right after "on" (or "via"…) in its message: "on GitHub Copilot", "through acme-go". Words
    // there that run on into a longer name, another provider's or the model's, name that one: "on Kiwi Coding" is not
    // Kiwi, nor is "using Kiwi K3".
    const vias = new Set([...VIA].flatMap((via) => said.at.get(via) ?? []));
    const after = (phrase: Phrase) =>
        starts(said, phrase)
            .filter(
                (start) => vias.has(start - 1) && said.messages[start - 1] === said.messages[start],
            )
            .map((start) => ({ start, length: phrase.words.length }));
    const providers = [...new Set([model.provider, ...twins.map((other) => other.provider)])];
    const named = providers.map((provider) =>
        [provider, providerName(provider)].flatMap((full) => after({ words: words(full) })),
    );
    const longest = new Map<number, number>();

    for (const { start, length } of [
        ...named.flat(),
        ...[model, ...twins].flatMap((each) => phrases(each, true).flatMap(after)),
    ]) {
        longest.set(start, Math.max(longest.get(start) ?? 0, length));
    }

    return named[0]!.some(({ start, length }) => length === longest.get(start));
}
