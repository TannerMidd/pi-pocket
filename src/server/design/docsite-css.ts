// The page's chrome reads its own `--dd-*` properties, so it never depends on the system it documents. The system's
// tokens are set on `body.ds`, where the specimens read them.

const LINK_ICON = `url("data:image/svg+xml,%3Csvg viewBox='0 0 20 20' fill='none' stroke='black' stroke-width='1.8' stroke-linecap='round' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M8.5 11.5a3 3 0 0 0 4.2 0l2.3-2.3a3 3 0 0 0-4.2-4.2l-.8.8'/%3E%3Cpath d='M11.5 8.5a3 3 0 0 0-4.2 0L5 10.8a3 3 0 0 0 4.2 4.2l.8-.8'/%3E%3C/svg%3E") center / contain no-repeat`;

export const DOC_CSS = `
:root {
    color-scheme: light;
    --dd-bg: #fafafc;
    --dd-panel: #ffffff;
    --dd-sunken: #f1f2f7;
    --dd-line: #e3e5ee;
    --dd-text: #14161f;
    --dd-muted: #566079;
    --dd-ok: #17703f;
    --dd-ok-soft: #e4f4ea;
    --dd-bad: #b0233b;
    --dd-bad-soft: #fbe6ea;
    --dd-warn: #84560a;
    --dd-warn-soft: #faf0dc;
    --dd-check: conic-gradient(#d9dbe3 25%, #fff 0 50%, #d9dbe3 0 75%, #fff 0) 0 0 / 12px 12px;
    --dd-radius: 12px;
    --dd-sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    --dd-mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
    --dd-top: 56px;
}

html[data-theme="dark"] {
    color-scheme: dark;
    --dd-bg: #0e0f15;
    --dd-panel: #161822;
    --dd-sunken: #11121a;
    --dd-line: #262938;
    --dd-text: #eceef7;
    --dd-muted: #a3abc4;
    --dd-ok: #7fd49e;
    --dd-ok-soft: #14291d;
    --dd-bad: #ff93a6;
    --dd-bad-soft: #3a161e;
    --dd-warn: #eab85a;
    --dd-warn-soft: #33270e;
    --dd-check: conic-gradient(#2a2d3a 25%, #1b1d27 0 50%, #2a2d3a 0 75%, #1b1d27 0) 0 0 / 12px 12px;
}

* { box-sizing: border-box; }
html { scroll-padding-top: calc(var(--dd-top) + 16px); -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--dd-bg); color: var(--dd-text); font: 15px/1.6 var(--dd-sans); }
h1, h2, h3, h4, p, ul, dl, dd, pre { margin: 0; }
button, input, select { font: inherit; color: inherit; }
button { cursor: pointer; }
code, pre, .tk, .v, .num, .val, .counts { font-family: var(--dd-mono); }
a { color: var(--dd-accent); }
:focus-visible { outline: 2px solid var(--dd-accent); outline-offset: 2px; }
[hidden] { display: none !important; }

.skip { position: absolute; left: 12px; top: -60px; z-index: 100; padding: 8px 12px; border-radius: 8px; background: var(--dd-accent); color: var(--dd-accent-ink); }
.skip:focus { top: 8px; }

.topbar {
    position: sticky;
    top: 0;
    z-index: 40;
    display: flex;
    align-items: center;
    gap: 12px;
    height: var(--dd-top);
    padding: 0 16px;
    border-bottom: 1px solid var(--dd-line);
    background: var(--dd-bg);
}
.brand { display: flex; align-items: baseline; gap: 10px; min-width: 0; margin-right: auto; }
.brand-name { overflow: hidden; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
.brand-sub { color: var(--dd-muted); font-size: 13px; white-space: nowrap; }
.icon-btn { display: none; width: 44px; height: 44px; margin-left: -10px; padding: 12px; border: 0; background: none; }
.seg { display: flex; padding: 3px; border: 1px solid var(--dd-line); border-radius: 10px; background: var(--dd-sunken); }
.seg button { min-height: 32px; padding: 0 12px; border: 0; border-radius: 7px; background: none; color: var(--dd-muted); font-size: 13px; }
.seg button[aria-pressed="true"] { background: var(--dd-panel); color: var(--dd-text); box-shadow: 0 1px 2px rgb(0 0 0 / 0.12); }
.modesel { display: none; min-height: 40px; padding: 0 8px; border: 1px solid var(--dd-line); border-radius: 8px; background: var(--dd-panel); }

.layout { display: grid; grid-template-columns: 260px minmax(0, 1fr); }
.side {
    position: sticky;
    top: var(--dd-top);
    height: calc(100vh - var(--dd-top));
    overflow-y: auto;
    padding: 16px 12px 32px;
    border-right: 1px solid var(--dd-line);
}
#q { width: 100%; min-height: 40px; margin-bottom: 12px; padding: 0 12px; border: 1px solid var(--dd-line); border-radius: 8px; background: var(--dd-panel); }
.nav { display: grid; }
.nav a { display: flex; align-items: center; min-height: 34px; padding: 0 10px; border-radius: 8px; color: var(--dd-muted); font-size: 14px; text-decoration: none; }
.nav a:hover { background: var(--dd-sunken); color: var(--dd-text); }
.nav a[aria-current="true"] { background: var(--dd-accent-soft); color: var(--dd-text); font-weight: 600; }
.nav .sub-link { min-height: 28px; padding-left: 22px; font-size: 13px; }
.nav-title { margin: 16px 10px 4px; color: var(--dd-muted); font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; }
.count { margin-left: auto; font: 12px var(--dd-mono); }

main { min-width: 0; max-width: 1120px; padding: 32px 40px 64px; }
.block { padding: 40px 0; border-top: 1px solid var(--dd-line); }
#overview { padding-top: 0; border-top: 0; }
.eyebrow { color: var(--dd-accent); font-size: 12px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; }
h1 { margin: 4px 0 8px; font-size: 40px; line-height: 1.1; letter-spacing: -0.02em; }
h2 { margin: 4px 0 8px; font-size: 28px; line-height: 1.2; letter-spacing: -0.01em; }
h3 { margin: 32px 0 6px; font-size: 19px; }
h4 { margin: 20px 0 10px; font-size: 14px; }
.lead { max-width: 64ch; color: var(--dd-muted); font-size: 17px; }
.intro, .sub { max-width: 70ch; margin-bottom: 12px; color: var(--dd-muted); }
.sub { font-size: 14px; }
.counts { margin-bottom: 8px; color: var(--dd-muted); font-size: 12px; }
.desc { display: block; color: var(--dd-muted); font-size: 13px; overflow-wrap: anywhere; }
.anchor { display: inline-block; width: 16px; height: 16px; margin-left: 8px; vertical-align: middle; opacity: 0; }
.anchor::before { content: ""; display: block; width: 100%; height: 100%; background: var(--dd-muted); -webkit-mask: ${LINK_ICON}; mask: ${LINK_ICON}; }
h2:hover .anchor, h3:hover .anchor, .anchor:focus-visible { opacity: 1; }

.tk, .mini {
    max-width: 100%;
    padding: 1px 6px;
    border: 1px solid var(--dd-line);
    border-radius: 5px;
    background: var(--dd-sunken);
    font-size: 12px;
    text-align: left;
    overflow-wrap: anywhere;
}
.tk + .tk { margin-left: 4px; }
.mini { min-height: 28px; padding: 2px 8px; font-weight: 600; }
.tk:hover, .mini:hover { border-color: var(--dd-accent); }
.flash { border-color: var(--dd-ok) !important; }
.pill { display: inline-block; padding: 0 7px; border-radius: 99px; background: var(--dd-sunken); color: var(--dd-muted); font-size: 11px; font-weight: 600; white-space: nowrap; }
.pill.ok { background: var(--dd-ok-soft); color: var(--dd-ok); }
.pill.bad { background: var(--dd-bad-soft); color: var(--dd-bad); }
.pill.warn { background: var(--dd-warn-soft); color: var(--dd-warn); }
.ratio { font: 600 13px var(--dd-mono); }

.hero { padding: 24px 0 8px; }
.strip { display: flex; flex-wrap: wrap; gap: 8px; margin: 24px 0; }
.strip .sw { display: grid; gap: 4px; width: 64px; padding: 0; border: 0; background: none; font-size: 11px; color: var(--dd-muted); white-space: nowrap; }
.strip .sw span { overflow: hidden; text-overflow: ellipsis; }
.strip .sw i, .chip { display: block; height: 36px; border: 1px solid var(--dd-line); border-radius: 8px; background: var(--dd-check); }
.chip { display: inline-block; width: 14px; height: 14px; margin-right: 6px; vertical-align: -2px; border-radius: 4px; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px; }
.stat { padding: 12px 14px; border: 1px solid var(--dd-line); border-radius: var(--dd-radius); background: var(--dd-panel); }
.stat b { display: block; font-size: 22px; }
.stat span { color: var(--dd-muted); font-size: 13px; }
.notes, .fold { margin-top: 16px; border: 1px solid var(--dd-line); border-radius: var(--dd-radius); background: var(--dd-panel); }
.notes summary, .fold summary { min-height: 44px; padding: 10px 14px; cursor: pointer; font-weight: 600; }
.fold summary .desc { display: inline; margin-left: 6px; font-weight: 400; }
.notes ul { padding: 0 16px 12px 36px; color: var(--dd-muted); font-size: 14px; }
.fold > :not(summary) { margin: 0 14px 14px; }

.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 240px), 1fr)); gap: 12px; }
.card, .family, .tile, .demo, .comp { border: 1px solid var(--dd-line); border-radius: var(--dd-radius); background: var(--dd-panel); }
.card { overflow: hidden; }
.card .sw { position: relative; display: block; width: 100%; height: 76px; padding: 0; border: 0; border-bottom: 1px solid var(--dd-line); background: var(--dd-check); }
.card .sw i { position: absolute; inset: 0; }
.aa { position: absolute; left: 14px; bottom: 8px; font-size: 24px; font-weight: 600; }
.aa small { font-size: 11px; }
.card-body { display: grid; gap: 6px; padding: 12px 14px 14px; }
.vals { display: grid; gap: 2px; font-size: 12px; }
.vals div { display: flex; gap: 10px; }
.vals dt { width: 40px; color: var(--dd-muted); }
.vals dd { font-family: var(--dd-mono); overflow-wrap: anywhere; }
.cr .desc { display: inline; }
.copies { display: flex; flex-wrap: wrap; gap: 6px; }
.ramp { display: grid; grid-template-columns: repeat(auto-fill, minmax(84px, 1fr)); overflow: hidden; border: 1px solid var(--dd-line); border-radius: var(--dd-radius); }
.step { min-height: 64px; padding: 8px; border: 0; text-align: left; }
.step b, .step small { display: block; font-size: 12px; }
.step small { font-family: var(--dd-mono); font-size: 11px; opacity: 0.85; }

.rows { border: 1px solid var(--dd-line); border-radius: var(--dd-radius); background: var(--dd-panel); }
.row { display: grid; grid-template-columns: minmax(0, 220px) minmax(90px, 140px) minmax(0, 1fr); gap: 16px; align-items: center; padding: 12px 14px; }
.row + .row { border-top: 1px solid var(--dd-line); }
.val { color: var(--dd-muted); font-size: 12px; overflow-wrap: anywhere; }
.sample { min-width: 0; overflow-wrap: anywhere; }
.sample .line { display: block; overflow: hidden; line-height: 1.3; white-space: nowrap; text-overflow: ellipsis; }
.bar { height: 10px; border-radius: 3px; background: var(--dd-accent); }
.box { max-width: 100%; border: 1px solid var(--dd-accent); background: var(--dd-accent-soft); }
.family { padding: 16px; }
.big { margin: 12px 0 4px; font-size: 56px; line-height: 1.1; }
.abc { margin-bottom: 8px; font-size: 14px; overflow-wrap: anywhere; }
.tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 150px), 1fr)); gap: 12px; }
.tiles.wide { grid-template-columns: repeat(auto-fill, minmax(min(100%, 220px), 1fr)); gap: 24px; }
.tile { display: grid; gap: 6px; align-content: start; padding: 14px; }
.shape { width: 72px; height: 56px; margin-bottom: 6px; border: 2px solid var(--dd-accent); background: var(--dd-accent-soft); }
.tile.lift { min-height: 120px; border-color: transparent; }

.demos { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr)); gap: 12px; }
.demo { padding: 12px 14px; }
.row-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
.demo > .desc { margin-top: 4px; font-family: var(--dd-mono); font-size: 12px; }
.play { min-height: 32px; margin-left: auto; padding: 0 12px; border: 1px solid var(--dd-line); border-radius: 8px; background: var(--dd-sunken); font-size: 13px; }
.curve { width: 36px; height: 36px; border: 1px solid var(--dd-line); border-radius: 6px; fill: none; stroke: var(--dd-accent); stroke-width: 5; }
.track { position: relative; height: 24px; margin-top: 10px; border-radius: 12px; background: var(--dd-sunken); }
.track i { position: absolute; top: 4px; left: 4px; width: 16px; height: 16px; border-radius: 50%; background: var(--dd-accent); transition: left var(--dur) var(--ease); }
.demo.on .track i { left: calc(100% - 20px); }

.comp { margin-top: 24px; padding: 16px; }
.comp h3 { margin: 0; }
.comp .intro { margin-top: 4px; }
.comp-stage { position: relative; isolation: isolate; min-height: 120px; margin-top: 12px; overflow: hidden; contain: layout paint; border: 1px solid var(--dd-line); border-radius: 10px; background: var(--g, var(--dd-panel)); color: var(--t, var(--dd-text)); font-family: var(--f, var(--dd-sans)); }
.comp-stage > .sub { margin: 12px; }
.dos { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr)); gap: 12px; margin-top: 12px; }
.dos > div { padding: 10px 14px; border-radius: 10px; border-left: 3px solid var(--dd-ok); background: var(--dd-ok-soft); }
.dos > .dont { border-color: var(--dd-bad); background: var(--dd-bad-soft); }
.dos h4 { margin: 0 0 4px; }
.dos ul { padding-left: 18px; font-size: 14px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chips .tk + .tk { margin-left: 0; }
.snip { margin-top: 12px; overflow: hidden; border: 1px solid var(--dd-line); border-radius: 10px; }
.snip-head { display: flex; align-items: center; justify-content: space-between; padding: 4px 6px 4px 12px; border-bottom: 1px solid var(--dd-line); background: var(--dd-sunken); font: 12px var(--dd-mono); }
.snip pre { max-height: 420px; overflow: auto; padding: 12px; font-size: 12px; line-height: 1.5; white-space: pre; }

.prose { max-width: 72ch; }
.prose > * + * { margin-top: 12px; }
.prose ul, .prose ol { padding-left: 22px; }
.prose code { padding: 1px 5px; border-radius: 4px; background: var(--dd-sunken); font-size: 0.88em; }
.prose pre { overflow: auto; padding: 12px; border-radius: 10px; background: var(--dd-sunken); }
.prose pre code { padding: 0; background: none; }
.prose blockquote { margin: 12px 0 0; padding-left: 14px; border-left: 3px solid var(--dd-line); color: var(--dd-muted); }

.table-wrap { overflow-x: auto; border: 1px solid var(--dd-line); border-radius: var(--dd-radius); background: var(--dd-panel); }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { padding: 8px 12px; border-bottom: 1px solid var(--dd-line); text-align: left; vertical-align: top; }
th { color: var(--dd-muted); font-size: 12px; font-weight: 600; white-space: nowrap; }
tr:last-child td { border-bottom: 0; }
.v, .num { font-size: 12px; overflow-wrap: anywhere; }
.all { color: var(--dd-muted); font-family: var(--dd-sans); }
.toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 12px; }
.toolbar input, .toolbar select { min-height: 40px; padding: 0 10px; border: 1px solid var(--dd-line); border-radius: 8px; background: var(--dd-panel); }
.toolbar input { flex: 1 1 220px; }

.empty { padding: 48px 0; color: var(--dd-muted); text-align: center; }
.foot { padding-top: 24px; border-top: 1px solid var(--dd-line); color: var(--dd-muted); font-size: 13px; }
.toast { position: fixed; left: 50%; bottom: 24px; z-index: 60; padding: 8px 14px; border-radius: 10px; background: var(--dd-text); color: var(--dd-bg); font-size: 14px; opacity: 0; transform: translate(-50%, 8px); transition: opacity 150ms, transform 150ms; pointer-events: none; }
.toast.show { opacity: 1; transform: translate(-50%, 0); }

@media (max-width: 959px) {
    .icon-btn { display: block; }
    .layout { display: block; }
    .side { position: fixed; inset: var(--dd-top) auto 0 0; z-index: 30; width: min(300px, 86vw); height: auto; background: var(--dd-bg); transform: translateX(-100%); transition: transform 200ms; }
    .nav-open .side { transform: none; box-shadow: 0 0 0 100vmax rgb(0 0 0 / 0.35); }
    main { padding: 24px 20px 48px; }
}

@media (max-width: 640px) {
    .brand-sub, .seg { display: none; }
    .modesel { display: block; }
    h1 { font-size: 32px; }
    h2 { font-size: 24px; }
    main { padding: 16px 16px 48px; }
    .block { padding: 32px 0; }
    .row { grid-template-columns: minmax(0, 1fr) auto; gap: 6px 12px; }
    .row .sample { grid-column: 1 / -1; }
    .card .sw { height: 52px; }
    .stack table, .stack tbody, .stack tr, .stack td { display: block; }
    .stack thead { display: none; }
    .stack tr { padding: 8px 0; border-bottom: 1px solid var(--dd-line); }
    .stack tr:last-child { border-bottom: 0; }
    .stack td { padding: 2px 12px; border: 0; }
    .stack td[data-label]::before { content: attr(data-label) " · "; color: var(--dd-muted); font: 600 11px var(--dd-sans); }
    .stack td[data-label="Token"]::before { content: none; }
}

@media (prefers-reduced-motion: reduce) {
    *, *::before { transition: none !important; }
}
`;
