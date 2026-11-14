# Goal extension: proposed host boundaries

Draft for [PR #323](https://github.com/TannerMidd/pi-pocket/pull/323#issuecomment-6831996554).
These backend APIs are **not implemented or agreed**. The workflow migration waits for maintainer review.

## Split

The extension must own the objective document, evaluator request and prompt, evidence limits,
verdict parsing, no-progress policy, token budget, commands, and UI. Goal is a bounded loop:
work → inspect evidence → continue or stop. A saved objective alone is not Goal mode.

Core must retain authentication, admission, queue and Plan priority, run lifecycle, and billing.
It must not understand goal states, evaluator verdicts, or completion criteria.

The UI follow-up adds an extension browser module and a small generic `pocket.composerBar`.
Its existing `host.objectiveGoals.view/command` bridge is **temporary and internal**. It is not
one of the proposed public APIs. The follow-up does not migrate or enlarge the evaluator workflow.

## Reuse, not new APIs

- `GenerationTask.onYield` and its `{ continue }` result already continue the same run.
  A second session, a timer that sends “keep going”, and a new unauthenticated run are not needed.
- `HookApi.memo`, module documents, and durable tasks already supply replay storage.
  Store an evaluation-start marker before the external request. An uncertain request must pause,
  not silently repeat a paid call after a restart. Persist its result and continuation receipt.
- `api.models.completeSimple`, `ProviderDoc`, and the run's selected model already supply the
  tool-free request. The extension selects no model that a person did not select.
- `UsageDoc` already supplies committed conversation tokens in a hook. Add the current, not yet
  committed answer once. `request.conversationUsage()` supplies the browser's usage view.
  A second token ledger or a new `usageOf` API is not required.
- `host.heldBack`, `host.on("run.ended")`, `web.conversationRoute`, `web.command`, `web.client`,
  and the existing sheets, menus, and status items can be reused.

## Proposed generic capabilities

Signatures below describe the contract, not final names. Each capability needs its own small PR
and tests before the Goal migration.

### 1. Submit to the bound conversation

Add `submit({ text }, key)` to a conversation command's context and to
`ConversationWebRequest`. This is the same-conversation equivalent of their linked-session start.

- Derive the actor and source from the command or authenticated route. Do not accept an actor id
  or an arbitrary conversation id from a browser or extension body.
- Check current visibility, steering, turn, model, spend, request lifetime, and source settings
  at final admission. Preserve normal Plan restrictions; a goal cannot approve a plan.
- Namespace the key by module, actor, and source. A retry returns the first submission receipt.
  Store the receipt with admission; reject use after the request ends.
- Preserve normal queue semantics. Resume during a run must not interrupt it or bypass its queue.

Tests: retry after a lost reply/restart, revoked access, different actors using one key, cancelled
requests, changed settings, turn changes, Plan, queued input, and spend refusal.

### 2. Admission-bound continuation gate

Propose `host.runs.continuation(api, { pendingUsage }, context)`, usable only from the current
`GenerationTask.onYield`. It returns a gate with a read-only reason and `continue(text, key)`.
The implementation can use the existing hook continuation result; it must not submit a new run.

- Bind it to the authenticated run and generation task, never a caller-supplied payer or person.
- Core owns queue, Plan, active child work, cancellation, and spend checks. The extension needs
  these decisions, not `PlanDoc`, `SubagentsDoc`, or writes to core documents.
- Recheck priority when accepting continuation, including replay of a stored continuation.
  A boolean sampled before a slow evaluator is not sufficient.
- Include the answer's uncommitted usage exactly once when checking limits.
- Keep the extension's revision check in its own durable state. Reject a stale verdict before
  it requests continuation. Replaying a continuation must not duplicate work.

Tests: input or Plan arriving during evaluation, a changed driver, stopped or failed runs,
child work, a stale goal revision, replay, and the last answer crossing a dollar limit.

### 3. Auxiliary model-usage accounting

Propose `host.modelUsage.capture(api, context)` and
`host.modelUsage.record(receipt, key, model, usage, context)` as one accounting capability.
The receipt captures the run's payer before the auxiliary request. It cannot select another payer.

- Recording is atomic and idempotent. The host owns the charge receipt and writes its existing
  conversation/person ledgers. An extension must not edit `UsageDoc` or billing documents.
- Record a returned response even when its verdict is malformed or its originating objective
  was edited or cleared. Those changes do not make a model response free.
- Keep the captured payer if a queued message changes the session's requester during evaluation.
- Return enough committed usage/limit information to stop before the next work turn.
- Define cancellation settlement explicitly. A cancelled web request must not lose known usage.
  A receipt is not a general capability to keep writing after a route returns.

Tests: replayed charges, payer changes during a call, paid malformed replies, cleared objectives,
limits crossed by the evaluation, cancellation, and committed versus pending worker usage.

The evaluator currently also uses private `noWait` request options. Agree whether auxiliary calls
can use a generic host request option for fail-fast provider limits, or need a small separate
adapter. Do not move that private import into a claimed standalone drop-in without resolving it.

## UI boundary

`pocket.composerBar({ id, title, component })` is independent of Goals. It can show a workflow,
review, or checklist above an ordinary session's composer. Components get the session id and
read-only steering state. They fail in isolation and disappear with the module. Core stores no
workflow state or presentation in this API.

Goal's browser module shows the objective and state, pause/resume, details, revision-safe edits,
confirmed deletion, tokens, budget, evaluator selection, and a summary request in PiP. The summary
opens a draft; it does not spend money or interrupt the main loop. Token use is not task completion.

References for the interaction pattern:

- [Using Goals in Codex](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex)
- [Long-running work](https://learn.chatgpt.com/docs/long-running-work), especially the progress row above the composer

## Migration order after agreement

1. Agree on the capability names and admission/accounting contracts above.
2. Land each generic backend capability and its tests separately.
3. Move the Goal document, evaluator, evidence collection, policy, commands, and routes into
   the extension. Preserve the stored `pocket.objective-goal` kind or provide an explicit,
   idempotent compatibility reader. Do not rename stored data in place.
4. Remove the private Goal host service and core route/workflow. Keep `/until` unchanged.
5. Decide the command packaging: current drop-in commands require a hyphen and cannot register
   the reserved `/goal` name. A built-in evaluator mode can keep the existing thin alias;
   a standalone drop-in can use `/session-goal` unless the command policy changes separately.
6. Run the existing completion, restart, race, queue, Plan, no-progress, and spend tests against
   the extension. Keep ordinary sessions free of evaluator calls.

## Suggested maintainer reply

Thank you. I agree with the extension-first split. I will keep the backend migration pending
until we agree on the host boundaries.

The existing generation hook, memos, model runtime, and usage reads already cover much of this.
I propose 3 generic capabilities: authenticated same-conversation submission from a bound command
or route; an admission-bound continuation gate that preserves queue/Plan priority and pending
answer spend; and idempotent auxiliary model accounting with a payer captured before the call.
Each can have separate tests and a prerequisite PR. None needs goal state or verdict policy in core.

I also prepared the controls as an extension browser module, using a generic composer-bar point.
The UI bridge to the current backend is temporary. The proposal above lists the security,
replay, accounting, and compatibility contracts that the migration must preserve.
