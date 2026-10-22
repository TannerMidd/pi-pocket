# Continue a chat after a subscription usage reset

Auto-resume is **off by default**. The owner can enable **Menu → App → Auto-resume by default** once for existing and future main chats. Individual chats can override that default. It continues an unfinished request in the same conversation after a supported provider reports when its five-hour subscription window resets. It does not reset the chat's context, resend the original prompt, switch models or credentials, purchase credits, or enable paid overflow.

## Enable and cancel

- **Menu → App → Auto-resume by default** is the owner's global on/off setting. It persists in `config.json` as `usageResumeDefault` and updates open tabs. Turning it off immediately cancels inherited pending wake-ups, including chats with no open browser; explicit per-chat opt-ins remain enabled.
- **Menu → Auto-resume after usage reset** overrides the setting for this chat. The menu shows whether the choice comes from the app default or this chat, or the pending wake-up time.
- `/auto-resume on` opts this chat in; `/auto-resume off` opts it out and cancels the pending wake-up. `/auto-resume` alone toggles it. `/auto-resume default` or **Use app auto-resume default** clears the override.
- Enable it before the request hits the limit; it does not scan old errors or resume a previously stopped chat retroactively.
- When a reset is recognized, a chat activity line says when Pi will try again. **Menu → Running now** lists the wake-up and its Stop control.
- **Stop** (`/stop` or the conversation's Stop action) also cancels a pending wake-up. It leaves the preference on for future requests.

Only the owner can change the global default. Someone allowed to steer and drive a chat can change its override, shared by everyone in that chat. Older per-chat opt-ins remain enabled. A fork follows the app default and inherits neither the parent's override nor its pending wake-up. The global default does not enable PiP or subagents.

## Which limits are supported

The feature reads the model error and the limit headers already observed on that exact failed provider response—not another chat's latest headers. The response correlation stays in memory and adds no message or conversation IDs to the stored header file. It makes **no usage-endpoint requests** and does not read credentials.

- **Codex/ChatGPT:** the native `You have hit your ChatGPT usage limit … Try again in ~N min.` message, token-sharing `subscription_sharing_usage_limit_exceeded` JSON with `resets_at`, and fresh rejected Codex five-hour-window headers.
- **Native Anthropic:** a fresh rejected unified five-hour-window header with its reset timestamp (Unix seconds or ISO date/time).
- Unknown reset times, ordinary HTTP 429 throttling, network errors, billing/entitlement errors, reset times more than five hours away, and an explicitly blocked weekly window are not automatically resumed. They remain manual.
- Claude Bridge and other extension providers may not expose those reset signals; their limits remain manual unless their error includes supported usage-reset guidance.

Pi waits an extra **one minute** after the reported reset, since friendly reset guidance can be rounded and clocks can differ. This is a single continuation attempt, not a guarantee that the provider's allowance is available: other chats or devices may consume it again. A new recognized error may schedule another wake-up.

## What happens at reset

The wake-up is a durable, conversation-owned task. It survives server restarts and browser closure; if the server is offline at reset, it checks whether continuation is still appropriate when the server starts. The server must eventually be running for it to act.

Before submitting anything, it checks that:

- the original generation actually failed, and its assistant error is still the newest transcript entry;
- auto-resume is still on, and the chat has the same model;
- the original requester still has access and steering/driver rights;
- the chat is not archived, has no active run, and its session/person spend limits permit work.

New input, a context reset, a model change, stopping the task, or a disabled preference prevents an old continuation. The eligibility checks and continuation admission share one atomic Session commit; config-file permissions are checked again before that commit completes, and revocation rolls back the staged admission. The continuation is submitted as work for the original requester, with a stable request ID so recovery cannot send it twice. It asks Pi to check existing progress and avoid repeating completed work or tool calls; it does not replay committed tools itself. It cancels rather than queues behind new work that started at the same time. A model changed while the failing request was still in flight also prevents a wake-up for that old response.

## Offline checks

```sh
node --test test/usage-reset.test.ts test/usage-resume.test.ts test/provider-limits.test.ts
npm run check
npm run lint
npm test
```

These tests use isolated data folders and scripted models, not live subscription requests. They cover reset parsing, concurrent response/header correlation, built-in retry recovery without an extra continuation, opt-in behavior, restart recovery, exactly-once continuation and attribution, cancellation, queued/new work, changed model/context, archive/spend checks, forks, and permission validation. Global-default tests run existing and new chats through a real failed generation, durable wake-up, restart with an advanced clock, and a completed continuation, with no per-chat activation. They also check inherited cancellation, opt-outs, HTTP permissions, and a default turned off during continuation admission. `test/usage-resume-ui.test.ts` checks the phone menu, defaults and overrides, new chats, and reload persistence in Chromium.

Core server changes require an owner restart; the global default stays off until enabled in the app.
