# Web search for Pi Pocket

A standalone, owner-managed extension providing `web_search`, `fetch_content`,
`web_crawl`, `web_research` and `web_research_status`. It adds a **Web search**
menu item and launcher entry with provider settings, a search tester and observed
request usage. It does not require changes to Pi Pocket's core or Providers sheet.

Requires **Pi Pocket 0.20.0 or later**, extension API 2 and the **experimental
`host.fetchPublic` API**. This API can change; the extension refuses to load when
it is unavailable. There is no fallback to unrestricted network access.

## Install

From this directory, copy the entry point and its companion directory into your
Pi Pocket drop-in directory (normally `~/.pi-pocket/extensions`):

```sh
mkdir -p ~/.pi-pocket/extensions
cp -R web-search.ts web-search ~/.pi-pocket/extensions/
```

In Pi Pocket, open **Extensions → Installed** and enable **web-search**, then
open **Web search** from the menu or launcher. Drop-ins start disabled. Only the
owner can access the settings, routes and browser module. Disabling the extension
removes its tools and UI and aborts its outstanding HTTP requests. Already-created
remote research jobs can continue at the provider.

Copy only `web-search.ts` and `web-search/`; development files, tests and
`node_modules` are not required. Pi Pocket supplies `_pocket.d.ts` for development.
The extension adds no runtime dependency beyond Pi Pocket's existing Pi packages.

The package can also be shared using Pi Pocket's **Share** action. Its manifest
must declare `minPocket: "0.20.0"`, `pocketApi: 2`, owner access, and every module
file with its generated hash. Share generates the file list; no gallery entry is
submitted by this package.

## Routing and provider options

The agent chooses `quick`, `standard` or `deep`; omitted tiers use `standard`.
Each tier has an editable, ordered provider/mode list. Failure falls through only
within that list. There is no automatic escalation to a more expensive tier;
select another tier or explicitly override the provider/mode when needed.

- Quick starts with Brave, then Exa lite, Tavily fast and DuckDuckGo.
- Standard starts with Exa auto, then Tavily basic, Brave and DuckDuckGo.
- Deep starts with Exa deep, then Tavily advanced.

Unconfigured providers are skipped. Settings include Exa lite/auto/deep-lite/deep,
Tavily search depth, extraction, crawl and research options, per-provider enabled
operations, extraction order and result limits. Crawl and research require Tavily.
OpenAI is an optional **synthesis** provider, not a live web search source, and is
excluded from the default tier lists. Starting research is not replay-safe and is
not automatically retried; polling its saved job ID is separate.

## Data, keys and network access

Settings and extension-only keys are stored in
`<host.dataDir>/web-search/web-search.json`; the request ledger and research jobs
are in `web-usage.json` alongside it. The directory is created with mode `0700`
and files with `0600`. Keys are masked in settings responses. This extension
**does not read** `~/.pi`, `auth.json`, Pi Pocket provider credentials or environment
variables. Enter a separate key in the extension's settings. Connection tests may
send a key entered in the form without saving it.

The following services can be contacted when selected or tested:

- `api.tavily.com`: API key, search queries, extraction/crawl URLs, crawl
  instructions, research questions, configured options and research job IDs.
- `api.exa.ai`: API key, search queries, extraction URLs, domain filters and
  configured content/search options.
- `api.search.brave.com`: API key, search query and result count.
- `google.serper.dev`: API key, search query and result count.
- `api.openai.com`: API key, selected model and a prompt containing the query for
  synthesis; a connection test requests the model list.
- `html.duckduckgo.com`: search query, without an API key.
- User/agent-supplied public target hosts: a `GET` for direct content extraction,
  or a validation `HEAD` before delegating a URL to Tavily/Exa. Direct redirects
  may contact further public hosts. No provider key is sent to these hosts.

Only operation inputs and configured options are sent, not conversation history.
All requests use `host.fetchPublic`. Pi Pocket checks and pins public HTTP/HTTPS
addresses, rejects private/loopback/metadata targets and checks redirects. Direct
requests follow checked redirects; provider API redirects are rejected. The
extension limits responses to 10 MiB and requests to at most 180 seconds, with
shorter operation deadlines. A local URL check cannot control how a remote
provider subsequently resolves or follows a submitted URL.

Fetched/provider output returned to the agent is defanged, fenced and labeled as
external data rather than instructions. Result links in the settings sheet accept
only HTTP/HTTPS URLs.

Usage is an **observed extension request ledger**, not account-wide usage or an
invoice. It counts attempted HTTP calls by provider, operation, mode, tier,
purpose and outcome, including failures, tests and research polling. Validation
`HEAD` calls appear as `direct` / `url-check` / `validation`. Host-internal
redirect hops are not separate ledger calls. Provider-reported credits are kept
separate from request counts; network failures can leave billing unknown. Other
applications' usage and provider-side work are not visible here.

For an existing core web-access setup, migration is deliberately manual: stop
using the old integration, back up its settings and ledger, then optionally copy
its `~/.pi/web-search.json` and `~/.pi/web-usage.json` into the new extension data
directory with file mode `0600`. Do not overwrite an existing extension ledger.
Keys formerly supplied by `auth.json` or environment variables must be entered
again. Keep the source files until you have verified the migrated settings.

## Development and validation

Use an existing Pi Pocket 0.20 checkout and its installed dependencies; no package
installation is required. Link that checkout's `node_modules` and
`types/pocket.d.ts` as this directory's `node_modules` and `_pocket.d.ts`.

```sh
npm run check
PI_POCKET_SOURCE=/path/to/pi-pocket-0.20 npm test
PI_POCKET_SOURCE=/path/to/pi-pocket-0.20 npm run test:browser
```

The regular tests cover tier fallback without escalation, provider options,
request accounting and storage, key isolation, fenced output, public-target
rejection and cancellation. With `PI_POCKET_SOURCE`, integration tests load the
extension into unmodified Pi Pocket, exercise real owner/non-owner routing,
disable cleanup, public-fetch guards and gallery manifest validation using an
in-memory HTTP transport. Without that variable, integration tests are skipped.
The optional browser check needs a working Chromium executable; it exercises the
settings at a mobile viewport. Tests use fake provider responses and do not spend
API credits. Real provider connectivity and billing require separate verification.
