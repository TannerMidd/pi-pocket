/**
 * Claude subscription requests: Anthropic decides by the shape of a request whether a Claude Code sign-in draws from
 * the subscription or is billed as a third-party app. Pi's Anthropic transport sends the Claude Code identity but not
 * the billing header that marks the request as Claude Code usage, so a real agent prompt is refused with
 * "Third-party apps now draw from your extra usage, not your plan limits" (400). `shapeRequest` adds that header; the
 * `anthropic-subscription` extension applies it when the owner turns that on.
 */
import { createHash } from "node:crypto";

/** The system block Anthropic's backend looks for, as Claude Code sends it. */
const BILLING_HEADER = "x-anthropic-billing-header:";

/** The salt and the first-message positions Claude Code's suffix hash uses. */
const SALT = "59cf53e54c78";
const POSITIONS = [4, 7, 20] as const;

/** The entrypoint Claude Code's headless and Agent SDK requests name. */
const ENTRYPOINT = "sdk-cli";

/**
 * The Claude Code version requests are shaped as: the one pi-ai's Anthropic transport reports in its
 * `claude-cli/<version>` user-agent, which Anthropic gates models on. Set the environment variable to raise it when
 * a model's floor is higher. It is read when the server starts.
 */
const VERSION = process.env.PI_POCKET_ANTHROPIC_CC_VERSION ?? "2.1.280";

/** A system block of an Anthropic request body. */
type TextBlock = { type?: string; text?: string; [key: string]: unknown };

/** A message of an Anthropic request body. */
type Message = { role?: string; content?: unknown };

/** An Anthropic request body, as pi-ai's transport builds it. */
interface Payload {
    system?: TextBlock[];
    messages?: Message[];
    [key: string]: unknown;
}

/** A request body that now carries the header ahead of its own system blocks. */
type Shaped = Payload & { system: TextBlock[] };

/** The text of a content block, when it is a text block. */
function textBlock(block: unknown): string | undefined {
    if (typeof block !== "object" || block === null) {
        return undefined;
    }

    const { type, text } = block as { type?: unknown; text?: unknown };

    return type === "text" && typeof text === "string" ? text : undefined;
}

/** The first user message's text, which seeds the header; empty when the request has none. */
function firstUserText(messages: Message[] | undefined): string {
    for (const message of messages ?? []) {
        if (message.role !== "user") {
            continue;
        }

        if (typeof message.content === "string") {
            return message.content;
        }

        if (!Array.isArray(message.content)) {
            continue;
        }

        for (const block of message.content) {
            const text = textBlock(block);

            if (text !== undefined) {
                return text;
            }
        }
    }

    return "";
}

/**
 * The header value: the version, a suffix over the first message, and a hash of that message. The hash is a stand-in
 * of the same shape as Claude Code's, not its algorithm.
 */
function headerValue(text: string): string {
    const sampled = POSITIONS.map((index) => text[index] ?? "0").join("");
    const suffix = createHash("sha256")
        .update(`${SALT}${sampled}${VERSION}`)
        .digest("hex")
        .slice(0, 3);
    const cch = createHash("sha256").update(text).digest("hex").slice(0, 5);

    return `${BILLING_HEADER} cc_version=${VERSION}.${suffix}; cc_entrypoint=${ENTRYPOINT}; cch=${cch};`;
}

/** Whether the request carries the Claude Code identity block Pi sends only with a subscription sign-in. */
export function isClaudeCodeRequest(payload: unknown): boolean {
    if (typeof payload !== "object" || payload === null) {
        return false;
    }

    const system = (payload as Payload).system;

    return Array.isArray(system) && (system[0]?.text ?? "").startsWith("You are Claude Code");
}

/**
 * One Anthropic request body with the billing header as its first system block, or undefined to leave it untouched:
 * not a request body, no system blocks to keep ahead of, no message to hash, or already shaped.
 */
export function shapeRequest(payload: unknown): Shaped | undefined {
    if (typeof payload !== "object" || payload === null) {
        return undefined;
    }

    const request = payload as Payload;

    if (!Array.isArray(request.system) || request.system.length === 0) {
        return undefined;
    }

    if (request.system.some((block) => block?.text?.startsWith(BILLING_HEADER))) {
        return undefined;
    }

    const text = firstUserText(request.messages);

    if (text === "") {
        return undefined;
    }

    return { ...request, system: [{ type: "text", text: headerValue(text) }, ...request.system] };
}
