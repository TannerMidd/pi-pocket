/**
 * Claude subscription billing: at your own risk, as Anthropic's terms and its help pages disagree on it, Anthropic counts
 * Pi Pocket's requests against a Claude subscription. The terms forbid using Claude "through automated or non-human
 * means" except with an API key or where Anthropic explicitly permits it; the help pages say third-party apps can use
 * subscription limits, yet Anthropic's servers often bill such requests as extra usage, and refuse them when that pool is
 * empty. This adds the header that Claude Code sends, so the requests look like Claude Code's. Anthropic may change how
 * it classifies requests, or act on an account it finds doing this. While this is off, requests go out as Pi builds them.
 */
import { isClaudeCodeRequest, shapeRequest } from "../anthropic-shape.ts";
import type { ExtensionWeb, PocketHost } from "../host.ts";

export default function createAnthropicSubscription(host: PocketHost, web: ExtensionWeb): void {
    const stop = host.shapeModelRequests((payload, model) =>
        model.provider === "anthropic" && isClaudeCodeRequest(payload)
            ? shapeRequest(payload)
            : undefined,
    );

    web.onDispose(stop);
}
