// Terminal helpers for the launcher: colors, keys, a one-line menu, yes/no questions, and QR codes.
import QRCode from "qrcode";

export const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
const colors = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;

const style = (open: string, close: string) => (text: string) =>
    colors ? `\x1b[${open}m${text}\x1b[${close}m` : text;

export const bold = style("1", "22");
export const dim = style("2", "22");
export const accent = style("38;5;209", "39");
export const green = style("32", "39");
export const yellow = style("33", "39");
export const red = style("31", "39");
export const cyan = style("36", "39");

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

export function visibleLength(text: string): number {
    return text.replace(ANSI, "").length;
}

export function columns(): number {
    return process.stdout.columns || 80;
}

/** Cut plain text to fit `width` columns. */
export function cut(text: string, width: number): string {
    if (width <= 1) {
        return "";
    }

    return text.length <= width ? text : `${text.slice(0, width - 1)}…`;
}

// ─── Keys ───────────────────────────────────────────────────────────────

export type Key = "up" | "down" | "enter" | "escape" | "ctrl-c" | (string & {});
type KeyListener = (key: Key) => void;

let listener: KeyListener | undefined;
let raw = false;

function parseKeys(data: string): Key[] {
    const keys: Key[] = [];

    for (let index = 0; index < data.length;) {
        const rest = data.slice(index);

        if (rest.startsWith("\x1b[A") || rest.startsWith("\x1bOA")) {
            keys.push("up");
            index += 3;
        } else if (rest.startsWith("\x1b[B") || rest.startsWith("\x1bOB")) {
            keys.push("down");
            index += 3;
        } else if (/^\x1b\[[0-9;]*[A-Za-z~]/.test(rest)) {
            index += /^\x1b\[[0-9;]*[A-Za-z~]/.exec(rest)![0].length;
        } else if (rest[0] === "\x1b") {
            keys.push("escape");
            index += 1;
        } else if (rest[0] === "\r" || rest[0] === "\n") {
            keys.push("enter");
            index += 1;
        } else if (rest[0] === "\x03") {
            keys.push("ctrl-c");
            index += 1;
        } else {
            keys.push(rest[0]!);
            index += 1;
        }
    }

    return keys;
}

/** Send key presses to `next` (or nowhere). The terminal is in raw mode from the first call until `restoreTerminal`. */
export function onKeys(next: KeyListener | undefined): KeyListener | undefined {
    const previous = listener;

    listener = next;

    if (!interactive || raw) {
        return previous;
    }

    raw = true;
    process.stdin.setRawMode(true);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (data: string) => {
        for (const key of parseKeys(data)) {
            listener?.(key);
        }
    });
    process.stdin.resume();

    return previous;
}

export function restoreTerminal(): void {
    if (raw) {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        raw = false;
    }

    if (process.stdout.isTTY) {
        process.stdout.write("\x1b[?25h");
    }
}

// ─── Questions ──────────────────────────────────────────────────────────

export interface Choice {
    label: string;
    detail: string;
    /** Shown but not selectable, with the detail saying why. */
    disabled?: boolean;
}

/** A menu picked with the arrow keys (or number keys). Resolves to the chosen index, or undefined on Escape or q. */
export function choose(
    title: string,
    choices: Choice[],
    initial: number,
): Promise<number | undefined> {
    return new Promise((resolve) => {
        const enabled = (index: number) =>
            choices[index] !== undefined && choices[index]!.disabled !== true;
        let index = enabled(initial) ? initial : choices.findIndex((_, each) => enabled(each));
        let drawn = 0;
        const labelWidth = Math.max(...choices.map((choice) => choice.label.length));

        const draw = () => {
            const width = columns();
            const lines = [`  ${bold(title)}`, ""];

            choices.forEach((choice, each) => {
                const selected = each === index;
                const pointer = selected ? accent("❯") : " ";
                const label = choice.label.padEnd(labelWidth);
                const room = width - 4 - labelWidth - 3;
                const detail = room >= 10 ? cut(choice.detail, room) : "";
                const shownLabel = choice.disabled ? dim(label) : selected ? bold(label) : label;

                lines.push(`  ${pointer} ${shownLabel}   ${dim(detail)}`);
            });
            lines.push("", dim(`  ${cut("↑↓ choose · enter select · esc cancel", width - 3)}`));

            if (drawn > 0) {
                process.stdout.write(`\x1b[${drawn}A\x1b[0J`);
            }

            process.stdout.write(`${lines.join("\n")}\n`);
            drawn = lines.length;
        };

        const move = (step: number) => {
            for (let next = index + step; next >= 0 && next < choices.length; next += step) {
                if (enabled(next)) {
                    index = next;

                    return;
                }
            }
        };

        process.stdout.write("\x1b[?25l");
        draw();
        const previous = onKeys((key) => {
            if (key === "up" || key === "k") {
                move(-1);
            } else if (key === "down" || key === "j") {
                move(1);
            } else if (/^[1-9]$/.test(key) && enabled(Number(key) - 1)) {
                index = Number(key) - 1;
            } else if (key === "enter") {
                return finish(index);
            } else if (key === "escape" || key === "q" || key === "ctrl-c") {
                return finish(undefined);
            }

            draw();
        });

        function finish(result: number | undefined) {
            onKeys(previous);
            process.stdout.write("\x1b[?25h");
            resolve(result);
        }
    });
}

/** A yes/no question answered with one key. */
export function confirm(question: string, fallback: boolean): Promise<boolean> {
    return new Promise((resolve) => {
        process.stdout.write(`  ${question} ${dim(fallback ? "[Y/n]" : "[y/N]")} `);
        const previous = onKeys((key) => {
            const answer =
                key === "y" || key === "Y"
                    ? true
                    : key === "n" || key === "N" || key === "escape" || key === "ctrl-c"
                      ? false
                      : key === "enter"
                        ? fallback
                        : undefined;

            if (answer === undefined) {
                return;
            }

            process.stdout.write(`${answer ? "yes" : "no"}\n`);
            onKeys(previous);
            resolve(answer);
        });
    });
}

export async function qrLines(text: string): Promise<string[]> {
    const out = await QRCode.toString(text, {
        type: "terminal",
        small: true,
        errorCorrectionLevel: "L",
    });

    return out.split("\n").filter((line) => line.length > 0);
}
