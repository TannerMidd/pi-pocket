# Auto-resume

Auto-resume continues a chat that a provider's usage or rate limit stopped. It waits until the reset time the provider gives, or a fixed delay when the provider gives none, and then sends Pi a message to go on from where it stopped. It does not change the model or its sign-in, buy credits, or turn on paid overflow.

It is the built-in module `auto-resume` (Menu → Extensions → **Auto-resume**). The owner can turn the whole module off there.

## Turn it on

It is off until someone turns it on:

- **Menu → Auto-resume** opens its sheet. **This chat** turns it on or off in the open chat; **Use default** returns the chat to the owner's default. The owner also sees **All chats by default** and **Retry without a reset time** (15 min to 5 h; 1 h by default).
- `/auto-resume on`, `off`, or `default` does the same for the chat, and `/auto-resume` alone says how it stands. The owner can type `/auto-resume all on`, `all off`, and `delay 45m` (10 minutes to 5 hours).

Anyone who can steer a chat can change its choice; while people take turns, only the person who drives. Only the owner changes the default and the delay. The default does not apply to PiP, and a fork follows the default, not its parent's choice. A subagent's conversation never resumes by itself: its session does.

Turn it on before the limit comes: it does not look back at errors from before.

## What happens

When a request fails and auto-resume is on in the chat, it reads the error:

1. **The response's own status and limit headers** (`host.responseLimits`), when the provider's API reports them: `retry-after`, `retry-after-ms`, `x-ratelimit-reset-*`, Codex's `x-codex-*` windows, and Anthropic's `anthropic-ratelimit-unified-5h-*`.
2. **The error's words**: `resets_at`, `resets_in_seconds`, Google's `retryDelay`, a date and time with its zone, and "try again in ~30 min", "retry in 41.2s", "reset after 2h34m12s".
3. **Nothing usable**: the owner's fixed delay.

It then sets up a repeating scheduled message for that time, plus one minute, at least ten minutes away: a chat activity notice says when. The scheduled message asks Pi to check its progress first, and not to repeat work or tool calls only because of the limit. It goes out as Pi's, as the work of the person Pi worked for, with the checks of any scheduled message: that person must still be able to steer, and spend limits apply.

- **An answer stops it.** Any successful answer in the chat (the continuation's, or one to a new message) cancels the retry.
- **A failed try counts.** When the continuation fails again with no reset time, the same retry goes on; a new reset time replaces it. It gives up after as many tries as fit in five hours (5 with the 1-hour delay), and says so.
- **Stop it** with **Cancel** in the sheet, `/auto-resume cancel`, **Stop** in Menu → Running now or Scheduled messages, or by turning it off in the chat. Turning the default off does not stop a retry already planned in another chat: stop it there.
- It survives a restart, as scheduled messages do. While the Scheduled messages module is off, no retry goes out, and auto-resume says it cannot plan one.

It is one try at a time, not a promise that the allowance is back: other chats and devices use the same allowance.

## Which errors

Providers share no error code, so the module (`src/server/extensions/_usage-limits.ts`) knows the ones that come with Pi. In this order:

1. A **daily, weekly, or monthly** limit never resumes by itself: "weekly", "monthly", "per day", Google's `PerDay` quotas, Kimi's `TPD`, Codex's window longer than 300 minutes, Anthropic's 7-day window. A reset more than five hours away does not either.
2. A **five-hour or session** window is a limit, even when its words also mention a balance (Z.ai's "Usage limit reached for the past 5 hours. Insufficient balance for extra usage").
3. **Billing and credit** never resume: `insufficient_quota`, `usage_not_included`, `402`, `billing_error`, credit balance, spend limits, `enforced_spend_limit_reached`, `exceeded_current_quota`, `Arrearage`, `FreeUsageLimitError`, `ServiceQuotaExceededException`.
4. A **limit** resumes: a 429 status, or words such as rate limit, usage limit, quota, `RESOURCE_EXHAUSTED`, throttling, overloaded.
5. Errors that cannot work again never resume: sign-in (401, 403), a request too large, refused content, and an invalid request (400, 404, 422).
6. Any other error (a crash, a network failure, a provider that says nothing) retries after the fixed delay.

| Provider                                                       | Limit                                                                                                       | Stays manual                                                     | Reset time                                                                   |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Codex (Sign in with ChatGPT)                                   | `usage_limit_reached`, "You have hit your ChatGPT usage limit", `subscription_sharing_usage_limit_exceeded` | `usage_not_included`, the weekly window                          | `x-codex-*-reset-*`, `resets_at`, `resets_in_seconds`, "Try again in ~N min" |
| OpenAI, Azure OpenAI                                           | 429, "Rate limit reached"                                                                                   | `insufficient_quota`, spend limits                               | `retry-after`, `retry-after-ms`, `x-ratelimit-reset-*`                       |
| Anthropic                                                      | `rate_limit_error`, unified 5-hour window `rejected`                                                        | credit balance, `enforced_spend_limit_reached`, the 7-day window | `retry-after`, `anthropic-ratelimit-unified-5h-reset`                        |
| Google Gemini, Vertex                                          | `RESOURCE_EXHAUSTED`                                                                                        | per-day quotas, `payment_required`                               | `retryDelay`, "Please retry in Ns"                                           |
| Mistral                                                        | 429, `rate_limit_error`                                                                                     | 402                                                              | `retry-after`                                                                |
| Bedrock                                                        | `ThrottlingException`                                                                                       | `ServiceQuotaExceededException`                                  | none: the fixed delay                                                        |
| OpenCode Go                                                    | `GoUsageLimitError`, "5-hour usage limit reached"                                                           | weekly and monthly limits, `FreeUsageLimitError`                 | "It will reset in N hours"                                                   |
| Z.ai coding plan                                               | 1308 "Usage limit reached for 5 hour"                                                                       | 1310 weekly or monthly, 1113 balance                             | none usable (its time has no zone): the fixed delay                          |
| Kimi                                                           | `rate_limit_reached_error`                                                                                  | `TPD`, `exceeded_current_quota_error`                            | `retry-after`                                                                |
| MiniMax                                                        | 2056 "usage limit exceeded", 1002                                                                           | 1008, 2053 balance or credit                                     | none: the fixed delay                                                        |
| Qwen (Model Studio)                                            | `Throttling.*`                                                                                              | `Arrearage`                                                      | none: the fixed delay                                                        |
| Xiaomi MiMo                                                    | 429                                                                                                         | 402                                                              | none: the fixed delay                                                        |
| OpenRouter, Groq, xAI, DeepSeek, Together, Fireworks, Cerebras | 429, "rate limit"                                                                                           | 402, credits, weekly or monthly budgets, "per day"               | `retry-after`, "Please try again in 5.289s"                                  |

`test/usage-limits.test.ts` has a real error for each line, with its source. Providers that extensions add get the same rules: their 429 and limit words resume, and the rest retries after the fixed delay. Google's APIs and extensions' providers report no headers, so only their words count.

## Check it

```sh
node --test test/usage-limits.test.ts test/auto-resume.test.ts test/auto-resume-ui.test.ts test/provider-limits.test.ts
```

The tests use scripted models and temporary data: no request goes to a provider. They cover each provider's errors, a retry at the reset time across a restart with the clock moved on, the fixed delay and its count, giving up, billing errors, an answer that ends a retry, Pi's own retry that recovers, who may change what, and the sheet on a phone's screen in Chromium.
