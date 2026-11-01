# Cache expiry pilot

This pilot observes existing requests. It does not compact, warm, send requests, change settings, or authorize spending.
It does not replace the branch’s existing idle-on-send compaction behavior.

## Enable on a throwaway server

Set `PI_POCKET_CACHE_EXPIRY_PILOT=observe` in the environment before starting a throwaway server.
Follow [Self-editing](self-editing.md) for isolated server setup. Do not use the running server’s data directory.
Unset the variable to disable the pilot on the next launch. No settings UI or private Pi fields are used.

## What it observes

- The final adapter payload, after caller hooks and extension request shapers.
- Native Anthropic Messages requests to `https://api.anthropic.com`, with explicit conversation cache breakpoints.
- A 5-minute or 1-hour TTL that agrees with the model’s public `promptCache` metadata. Mixed TTLs use the shortest lifetime.
- Successful response usage that reports cache reads or writes. Cache usage alone does not prove full conversation coverage.

Other providers, proxies, missing metadata, unsupported payloads, disabled caches, and zero cache usage produce no timer.
A cached system prompt alone does not qualify. Nothing polls the provider for an expiry timestamp.

The estimated expiry starts at request dispatch, not response completion.
The pilot makes one diagnostic decision at 90% of the TTL: 4 minutes 30 seconds or 54 minutes.
This is an inferred deadline, not a provider guarantee. It can underestimate expiry conservatively.

Each new request replaces that provider session’s observation. Older responses cannot overwrite newer ones.
Late responses, missed timers, backwards clock changes, and failed assessments do not trigger catch-up work.
Decisions never rearm themselves. Restart discards observations; a fresh successful request is required.
Existing cache-keeper requests also pass through this observer, but the pilot never creates them.

## Read the output

Look for `[cache-expiry-pilot]` in the server log. `observed` records contain:

- Conversation ID, provider, model, request start, TTL, estimated expiry, and decision time.
- Reported input, output, cache-read, and cache-write token counts.
- Explicit uncertainty about expiry and cached-prefix coverage.

At the decision time the pilot checks current activity, model identity, spend limits,
PiP/child ownership, and the active model’s effective policy through `getCompactionSettings(model)`.
It estimates context size and checks for enough removable context and regrowth.
The result says `action: "observe-only"`. A context candidate is not an economic approval.
The pilot logs no prompt, response text, API key, provider session ID, or raw payload.

## Validation and next gate

Run the deterministic, network-intercepted tests:

```sh
node --test test/cache-expiry-pilot.test.ts test/cache-expiry-pilot-app.test.ts
```

Tests use the real Anthropic adapter with intercepted `fetch`, synthetic usage, and a fake clock.
They do not establish a real cache hit, actual provider expiry, monetary savings, or summary quality.

A scripted summary probe also exercises the public `onPayload` boundary and preserves the original
system, tools, request configuration, and conversation input prefix in the outgoing summary candidate.
This is structural evidence only. The production observer does not store those payloads or submit summaries.

Before enabling actual compaction, implement the public summarization hook, verify real cache reads
for the summary request, and bound both summary cost and expected savings against remaining budgets.
A useful economic comparison must include the existing clipped standalone summarizer.
Do not enable automatic spending based on this pilot’s context threshold.
