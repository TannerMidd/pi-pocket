# Web access configuration

Open **Menu → Web access** to configure provider options, search tiers,
extraction fallback, enabled operations, and observed request counts. Owner-only
controls save immediately, except provider option forms, which have a Save button.
The settings, request ledger, connection tests, and live-search tester are owner-only.
Conversation participants use web tools through the normal agent access and approval rules.

## Search tiers and fallback

Pi chooses a tier for `web_search`: **quick** for a simple lookup, **standard**
for general searches, or **deep** for broader retrieval. Omitting the tier selects
standard. The live-search tester provides the same tier selection, plus strict
provider and mode overrides. Choosing a mode override requires a provider.

Each tier has an ordered chain of provider/mode entries. Reorder entries with
the up/down buttons, change their provider or mode, or add/remove entries.
Provider default means the mode selected in that provider's options.

New configurations start with:

- Quick: Brave → Exa Lite → Tavily Fast → DuckDuckGo.
- Standard: Exa Auto → Tavily Basic → Brave → DuckDuckGo.
- Deep: Exa Deep → Tavily Advanced.

Existing configurations without saved tiers keep their primary provider and
legacy order for standard searches. Saving a tier opts into all three displayed
chains. Serper and OpenAI remain selectable entries. The existing OpenAI adapter
provides model synthesis; it does not perform a live search.

Unavailable keys and disabled operations are skipped without sending requests.
Provider errors, network failures, and empty results advance to the next entry.
Cancellation stops the chain. Exhausting a tier reports the attempted providers;
it never automatically escalates to another tier. An explicit provider uses only
that provider. Search results report the actual provider, mode, tier, and attempts.

Tiers are routing preferences, not equivalent quality or pricing guarantees. The
owner may place any supported provider/mode in a tier. Deep search does not
implicitly start a research job.

## Provider options and operations

**Exa** supports Lite, Auto, Deep Lite, and Deep search; text or highlights;
characters per result; and included/excluded domains. Lite uses cached content
and is sent only compatible options. Deep modes have a longer request timeout.
Exa also supports URL extraction through its Contents API.

**Tavily** supports:

- Search: Ultra Fast, Fast, Basic, or Advanced; topic; time range; answer inclusion;
  and included/excluded domains. Explicit search depth prevents automatic upgrades.
- Extract: Basic/Advanced depth, text/Markdown format, and timeout. These settings
  also apply to crawl.
- Crawl: maximum depth, breadth, page count, and whether external domains may be
  followed. `web_crawl` accepts a public URL and optional instructions.
- Research: Mini, Pro, or Auto. `web_research` explicitly starts a research report
  and returns a persisted job ID. `web_research_status` retrieves that job later.

The Enabled operations group turns supported operations off/on per provider.
Extraction has its own reorderable fallback chain: Direct, Tavily, and Exa. Direct
fetch remains first by default. `fetch_content` keeps its existing arguments and
text/truncation output, and accepts an optional strict extraction provider.

Research creation is not replay-safe. It is never automatically retried, and an
uncertain submission is reported rather than silently starting another billable
job. Saved job IDs survive restart. Status requests can retrieve existing jobs
even after new research is disabled. Research reports and crawl output are capped
at 100,000 characters in tool replies.

## Observed requests

Today, This month, and All time group requests by provider, operation, mode, and
purpose. Dates use UTC. Refresh usage retrieves the latest observations.

- Each actual provider attempt is counted, including fallback and connection tests.
  Missing keys and rejected arguments send no request and are not counted.
- Success, failure, and pending/unknown counts describe HTTP requests. An HTTP
  success may contain empty search results and still cause fallback.
- A timeout or interrupted request may have reached the provider. It remains
  pending/unknown rather than implying that no billable work occurred.
- Research jobs and status polls are separate. Repeated polls of a completed job
  do not count its cumulative credit usage again.
- Credits and dollars are recorded only when supplied by the provider. Each unit
  is shown separately; missing dollar information is unknown, not zero. Reported
  amounts can cover only some requests and are not an invoice.

Tracking starts with the first observed request. It cannot reconstruct older
history or include requests from other applications. The ledger contains daily
aggregates and research handles, without queries, fetched content, URLs, or keys.

## Storage and validation

Configuration is `~/.pi/web-search.json`; observations and research handles are
in `~/.pi/web-usage.json`. When `PI_CODING_AGENT_DIR` is set, the parent of that
directory is used instead, including for isolated tests. Configuration and usage
updates are serialized across manager instances and written atomically with
owner-only permissions. Run one server process per configuration directory.

Older configuration keys and unknown fields survive saves. Provider/mode
combinations and numeric bounds are validated before sending requests. Public
URL checks apply to extraction and crawl; direct redirects are checked again.
The direct reader's URL checks are not a DNS-rebinding protection mechanism.

Implementation lives in `src/server/web-access.ts`,
`src/server/web-access-settings.ts`, `src/server/web-access-storage.ts`,
`src/server/extensions/web-access.ts`, and the Web access sheet. The built-in module accesses
the shared manager through the internal `host.webAccess` service, with no runtime imports of core.
Focused backend
and Chromium tests are `test/web-access.test.ts` and `test/web-access-ui.test.ts`.

Core server changes require an owner restart after checks. The UI tolerates the
older backend while the running server waits for that restart.

## Provider references

- [Exa Search](https://exa.ai/docs/reference/search) and
  [Contents](https://exa.ai/docs/reference/get-contents).
- [Tavily Search](https://docs.tavily.com/documentation/api-reference/endpoint/search),
  [Extract](https://docs.tavily.com/documentation/api-reference/endpoint/extract), and
  [Crawl](https://docs.tavily.com/documentation/api-reference/endpoint/crawl).
- [Tavily Research creation](https://docs.tavily.com/documentation/api-reference/endpoint/research)
  and [status/results](https://docs.tavily.com/documentation/api-reference/endpoint/research-get).

## Verification

Run `node --test test/web-access.test.ts test/web-access-ui.test.ts` for offline provider,
routing, accounting, access-control, and phone-browser checks. The browser test checks saved defaults,
route order, mode edits, crawl-limit persistence after reload, and horizontal overflow.
Provider requests use mocked responses; actual account access and billing require separate verification.
