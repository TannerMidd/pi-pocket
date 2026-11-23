# Browser performance tests

## Runner file reads

Run from the repository root after `npm ci`. Playwright is only needed for this benchmark:

```sh
npm install --prefix test/perf --no-save --package-lock=false playwright
npx --prefix test/perf playwright install chromium
systemd-run --user --scope -q --expand-environment=no -p CPUQuota=200% -- \
  node test/perf/runner-read.mjs
```

Set `PI_POCKET_BROWSER` to use an existing Chromium executable instead. The lab starts a
real runner process and a port-0 server with a temporary `HOME` and a faux model. It grants
approval only to the new lab session in its temporary folder. A TCP proxy adds half of the
selected RTT in each direction of the runner link only. The browser measures from the model
issuing `read` or `edit` until the tool result summary appears in the transcript. The read file
is 36 bytes. The edit is an unchanged control.

At +0, +20, +50 and +100 ms RTT, the lab alternates the old path and the snapshot path in the
same session. It disables only the snapshot capability for the old path. It skips 2 warmup
pairs, then prints all 24 pairs, their request names, the median and nearest-rank p95 for each
path, and the median of `before − after` in milliseconds. A positive difference means the
snapshot path took less time. Independent workspace requests can appear in the request list.
