// The Spark panel: the DGX cluster's live telemetry, docked beside the conversation like the Browser panel.
// The layout follows Ben's DeepSeek Harness dashboard: per node a Power, Silicon, Memory, Serve, and System tile,
// then the cluster's life tally, fresh from the server's cached proxy every 5 seconds.
import { useEffect, useRef, useState } from "preact/hooks";
import { api, panelsBeside, store } from "./store.js";
import { useBack } from "./back.js";
import { html, Icon } from "./ui.js";

const POLL_MS = 5000;
const OPEN_KEY = "pocket.spark";

/** Watts: under 70 nominal, to 95 elevated, past it peak — the Hermes scale. */
const WARN_W = 70;
const HOT_W = 95;
const WARN_T = 65;
const HOT_T = 80;
const SEGN = 28;

const DASH = "—";
const fmt = (n, d = 1) => (typeof n === "number" && isFinite(n) ? n.toFixed(d) : DASH);
const th = (n) =>
    typeof n === "number" && isFinite(n) ? Math.round(n).toLocaleString("en-US") : DASH;

const tok = (n) => {
    if (typeof n !== "number" || !isFinite(n)) {
        return DASH;
    }

    if (n >= 1e9) {
        return (n / 1e9).toFixed(2) + "B";
    }

    if (n >= 1e6) {
        return (n / 1e6).toFixed(1) + "M";
    }

    return Math.round(n).toLocaleString("en-US");
};

const dur = (s) => {
    if (typeof s !== "number" || !isFinite(s)) {
        return DASH;
    }

    const d = Math.floor(s / 86400);
    const p = (x) => (x < 10 ? "0" : "") + x;

    return `${d}d ${p(Math.floor((s % 86400) / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(Math.floor(s % 60))}`;
};

/** Open the panel, taking the place of the Browser panel and the Files tile. */
export function setSparkOpen(open) {
    if (open) {
        sessionStorage.setItem(OPEN_KEY, "1");
        sessionStorage.removeItem("pocket.browser");
        sessionStorage.removeItem("pocket.files");
    } else {
        sessionStorage.removeItem(OPEN_KEY);
    }

    store.set({
        sparkOpen: open,
        drawer: false,
        ...(open ? { browserOpen: false, filesOpen: false } : {}),
    });
}

export const toggleSpark = () => setSparkOpen(!store.state.sparkOpen);

/** The cluster's status, polled only while mounted and the tab is up. Exported for the status line's chip. */
export function useSpark() {
    const [state, setState] = useState({ data: null, error: null });

    useEffect(() => {
        let gone = false;
        let timer;

        const tick = async () => {
            if (document.hidden === false) {
                try {
                    const response = await api("spark");

                    if (!gone) {
                        setState({ data: response, error: null });
                    }
                } catch (error) {
                    if (!gone) {
                        setState({ data: null, error: String(error?.message ?? error) });
                    }
                }
            }

            if (!gone) {
                timer = setTimeout(tick, POLL_MS);
            }
        };

        tick();

        return () => {
            gone = true;
            clearTimeout(timer);
        };
    }, []);

    return state;
}

/** The two nodes out of the dashboard's one payload; `peer` fields are node 2's. */
function nodes(d) {
    const n1 = {
        up: true,
        power_w: d.power_w,
        gpu_temp: d.gpu_temp,
        gpu_util: d.gpu_util,
        gpu_clock: d.gpu_clock_mhz,
        tok_s: d.tok_s,
        prefill: d.prefill_tok_s,
        mem_used: d.sys_mem_used_gb,
        mem_total: d.sys_mem_total_gb,
        mem_pct: d.sys_mem_pct,
        disk_pct: d.disk_used_pct,
        disk_free: d.disk_free_gb,
        disk_total: d.disk_total_gb,
        model: d.model,
        model_len: d.model_len,
        serve_state: d.server_state,
        serve_port: d.server_port,
        uptime: d.uptime_s,
        boot: d.boot_time,
        dash_up: d.dash_uptime_s,
        load1: d.load1,
        load5: d.load5,
        load15: d.load15,
        cores: d.cores,
        hist_w: d.hist_w,
        hist_u: d.hist_u,
        hist_c: d.hist_c,
        ev: d.hist_every_s,
    };
    const up = d.peer_state === "up";
    const n2 = {
        up,
        power_w: d.peer_power_w,
        gpu_temp: d.peer_gpu_temp,
        gpu_util: d.peer_gpu_util,
        gpu_clock: d.peer_gpu_clock_mhz,
        tok_s: d.peer_tok_s,
        prefill: d.peer_prefill_tok_s,
        mem_used: d.peer_sys_mem_used_gb,
        mem_total: d.peer_sys_mem_total_gb,
        mem_pct: d.peer_sys_mem_pct,
        disk_pct: d.peer_disk_used_pct,
        disk_free: d.peer_disk_free_gb,
        disk_total: d.peer_disk_total_gb,
        model: up ? d.peer_model : null,
        serve_state: up ? d.peer_serve_state : "down",
        uptime: d.peer_uptime_s,
        load1: d.peer_load1,
        load5: d.peer_load5,
        load15: d.peer_load15,
        cores: d.peer_cores,
        hist_w: d.peer_hist_w,
        hist_u: d.peer_hist_u,
        hist_c: d.peer_hist_c,
        ev: d.peer_hist_every_s,
    };

    return [n1, n2];
}

const Tile = ({ label, note, children }) => html`
    <div class="spark-tile">
        <div class="spark-lbl">
            ${label}
            ${note && html`<span class="spark-note"> · ${note}</span>`}
        </div>
        ${children}
    </div>
`;

const Bar = ({ pct, cls = "", zones }) => html`
    <div class=${`spark-bar ${cls}`}>
        <div class="spark-fill" style=${`width:${Math.max(0, Math.min(100, pct))}%`}></div>
        ${zones && html`<div class="spark-zones" style=${`background:${zones}`}></div>`}
    </div>
`;

const Ticks = ({ items }) => html`
    <div class="spark-ticks">${items.map((t) => html`<span key=${t}>${t}</span>`)}</div>
`;

const Kv = ({ parts }) =>
    html`<div class="spark-kv">${parts.map((p, i) => html`<span key=${i}>${p}</span>`)}</div>`;

const Segs = ({ pct }) => {
    const on = Math.round(((pct || 0) / 100) * SEGN);

    return html`<div class="spark-segs" aria-hidden="true">
        ${Array.from({ length: SEGN }, (_, i) => html`<span key=${i} class=${i < on ? "on" : ""}></span>`)}
    </div>`;
};

/** A sparkline with a filled area, an axis at top and bottom, and the last point dotted. */
function Chart({ data, h = 44 }) {
    const ref = useRef(null);
    const [w, setW] = useState(0);

    useEffect(() => {
        const upd = () => ref.current && setW(ref.current.clientWidth);

        upd();
        const id = setInterval(upd, 700);

        return () => clearInterval(id);
    }, []);

    const W = w || 300;
    const kids = [];

    if (data && data.length > 1) {
        let lo = Math.min(...data);
        let hi = Math.max(...data);
        const span = hi - lo || 1;

        lo -= span * 0.08;
        hi += span * 0.14;

        const X = (i) => 1 + (i * (W - 2)) / (data.length - 1);
        const Y = (v) => h - 6 - ((v - lo) / (hi - lo)) * (h - 12);
        const pts = data.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`);
        const area = `M${pts.join(" L")} L${X(data.length - 1).toFixed(1)},${h - 1} L${X(0).toFixed(1)},${h - 1} Z`;

        kids.push(
            html`<path key="ar" d=${area} class="spark-ar" />`,
            html`<polyline key="ln" points=${pts.join(" ")} class="spark-ln" />`,
            html`<circle key="dt" cx=${X(data.length - 1)} cy=${Y(data[data.length - 1])} r="2.4" class="spark-dt" />`,
        );
    }

    return html`<div class="spark-chartbox" ref=${ref}>
        <svg class="spark-chart" viewBox=${`0 0 ${W} ${h}`} preserveAspectRatio="none" style=${`height:${h}px`}>${kids}</svg>
    </div>`;
}

function PowerTile({ s, note }) {
    const w = s.power_w;
    const hasW = s.up && typeof w === "number" && isFinite(w);
    const cls = hasW ? (w >= HOT_W ? "hot" : w >= WARN_W ? "warn" : "") : "";
    const hw = s.hist_w || [];
    const avg = hw.length ? hw.reduce((a, b) => a + b, 0) / hw.length : w;

    return html`<${Tile} label="Power draw" note=${note}>
        <div class=${`spark-big ${cls}`}>${fmt(w, 1)}<span class="spark-unit">W</span></div>
        <div class=${`spark-state ${cls}`}>
            ${hasW ? (w >= HOT_W ? "PEAK" : w >= WARN_W ? "ELEVATED" : w >= 45 ? "NOMINAL" : "IDLE") : s.up ? "ACQUIRING" : "OFFLINE"}
        </div>
        <${Bar} pct=${hasW ? (w / 140) * 100 : 0} cls=${cls}
            zones="linear-gradient(90deg,transparent 0 50%,var(--warn-soft) 50% 67.9%,var(--err-soft) 67.9%)" />
        <${Ticks} items=${["0", "35", "70 W", "105", "140"]} />
        <${Kv} parts=${[
            `avg ${hasW ? fmt(avg, 1) + " W" : DASH}`,
            `min ${hasW ? fmt(hw.length ? Math.min(...hw) : w, 1) + " W" : DASH}`,
            `max ${hasW ? fmt(hw.length ? Math.max(...hw) : w, 1) + " W" : DASH}`,
        ]} />
        <${Chart} data=${hw} h=${64} />
        <div class="spark-dim">
            ${hasW && html`· ${Math.max(1, Math.round((hw.length * (s.ev ?? 2)) / 60))} min window · ${s.ev ?? 2} s samples`}
        </div>
    <//>`;
}

function SiliconTile({ s }) {
    const t = s.gpu_temp;
    const tCls = typeof t === "number" ? (t >= HOT_T ? "hot" : t >= WARN_T ? "warn" : "") : "";
    const hc = s.hist_c || [];

    return html`<${Tile} label="GPU">
        <div class="spark-val">${fmt(s.gpu_util, 0)} %</div>
        <${Segs} pct=${s.gpu_util} />
        <div class="spark-trio">
            <div>
                <div class=${`spark-n ${tCls}`}>${fmt(t, 0)}°</div>
                <div class="spark-t">GPU temp</div>
                <div class="spark-mb">
                    <div style=${`width:${Math.min(100, Math.max(0, (((t ?? 0) - 30) / (95 - 30)) * 100))}%;background:var(--${tCls === "hot" ? "err" : tCls === "warn" ? "warn" : "accent"})`}></div>
                </div>
            </div>
            <div>
                <div class="spark-n">${fmt(s.gpu_clock / 1000, 2)} GHz</div>
                <div class="spark-t">SM clock</div>
                <div class="spark-mb"><div style=${`width:${Math.min(100, (s.gpu_clock / 3000) * 100)}%`}></div></div>
            </div>
            <div>
                <div class="spark-n ok">${s.up && isFinite(s.tok_s) ? th(s.tok_s) : DASH}</div>
                <div class="spark-t">tok/s gen</div>
            </div>
            <div>
                <div class="spark-n ok">${s.up && s.prefill > 0 ? th(s.prefill) : DASH}</div>
                <div class="spark-t">tok/s prefill</div>
            </div>
        </div>
        <${Kv} parts=${[`lo ${fmt(hc.length ? Math.min(...hc) : t, 0)}°`, `avg ${fmt(hc.length ? hc.reduce((a, b) => a + b, 0) / hc.length : t, 0)}°`, `hi ${fmt(hc.length ? Math.max(...hc) : t, 0)}°`]} />
        <${Chart} data=${s.hist_u} h=${34} />
    <//>`;
}

function MemTile({ s }) {
    const mp = s.mem_pct || 0;
    const mCls = mp >= 90 ? "hot" : mp >= 75 ? "warn" : "";
    const dp = s.disk_pct || 0;
    const dCls = dp >= 92 ? "hot" : dp >= 80 ? "warn" : "";

    return html`<${Tile} label="Unified memory · CPU+GPU shared">
        <div class=${`spark-val ${mCls}`}>${fmt(s.mem_used, 1)}<small> / ${fmt(s.mem_total, 0)} GB</small></div>
        <${Bar} pct=${mp} cls=${mCls} zones="linear-gradient(90deg,transparent 0 75%,var(--warn-soft) 75% 90%,var(--err-soft) 90%)" />
        <${Ticks} items=${["0", "75% warn", "100%"]} />
        <${Kv} parts=${[`free ${fmt(s.mem_free, 1)} GB`, `${fmt(mp, 0)}% used`]} />
        <div class="spark-lbl" style="margin-top:15px">NVMe pool</div>
        <div class=${`spark-val ${dCls}`}>${fmt(dp, 0)} %</div>
        <${Bar} pct=${dp} cls=${dCls} zones="linear-gradient(90deg,transparent 0 80%,var(--warn-soft) 80% 92%,var(--err-soft) 92%)" />
        <${Ticks} items=${["0", "80% warn", "100%"]} />
        <${Kv} parts=${[`free ${fmt(s.disk_free, 0)} GB`, `total ${fmt(s.disk_total, 0)} GB`]} />
    <//>`;
}

function ServeTile({ s }) {
    const hasModel = s.up && s.model;

    return html`<${Tile} label="Served model">
        <div class=${`spark-model ${hasModel ? "" : "down"}`}>${s.model ?? (s.up ? "no model served" : "node offline")}</div>
        <div class="spark-kv">
            ${
                !s.up
                    ? html`<b class="err">NODE OFFLINE</b>`
                    : hasModel
                      ? html`<span>ctx <b>${tok(s.model_len)} tokens</b> · <b class="acc">SERVING :${s.serve_port}</b></span>`
                      : html`<span class="err">DOWN</span>`
            }
        </div>
    <//>`;
}

function SysTile({ s }) {
    const cores = s.cores || 1;
    const bar = (v) => ({ width: `${Math.min(100, ((v || 0) / cores) * 100)}%` });

    return html`<${Tile} label="Uptime · load">
        <div class="spark-val cool">${dur(s.uptime)}</div>
        <div class="spark-kv">${s.boot ?? ""}${s.dash_up ? html`<span> · dashboard ${dur(s.dash_up)}</span>` : null}</div>
        <div class="spark-trio">
            ${["1 min", "5 min", "15 min"].map((label, i) => {
                const v = s[`load${[1, 5, 15][i]}`];

                return html`<div key=${label}>
                    <div class="spark-n">${fmt(v, 2)}</div>
                    <div class="spark-t">${label}</div>
                    <div class="spark-mb"><div style=${bar(v)}></div></div>
                </div>`;
            })}
        </div>
        <${Kv} parts=${[`${cores} cores`, "100% = all cores busy"]} />
    <//>`;
}

function LifeTally({ d }) {
    const cells = [
        ["Tokens in", "prompt", tok(d.prompt_tokens)],
        ["Tokens out", "generated", tok(d.gen_tokens)],
        ["Requests", "finished", th(d.requests)],
        ["Engine runs", "counted", th(d.life_engines)],
    ];

    return html`<div class="spark-lt">
        <div class="spark-lbl">Life tally <span class="spark-note">· every token through the pair, across model swaps</span></div>
        <div class="spark-lt-hero">${tok(d.life_total)}<span class="spark-unit">tokens produced · in + out</span></div>
        <div class="spark-lt-grid">
            ${cells.map(
                ([k, note, v]) => html`<div key=${k} class="spark-lt-cell">
                    <div class="spark-t">${k} <span class="spark-note">${note}</span></div>
                    <div class="spark-n">${v}</div>
                </div>`,
            )}
        </div>
        <div class="spark-dim">
            since <b>${d.life_since ? new Date(d.life_since * 1000).toLocaleDateString() : DASH}</b> · survives model unload/reload
        </div>
    </div>`;
}

/** The panel: the two nodes' banks stacked, the life tally, and a sync footer, DSH's sidebar layout. */
export function SparkPanel({ leaving = false }) {
    const { data, error } = useSpark();

    // Over the conversation (a phone), back closes the panel.
    useBack(!panelsBeside() && !leaving, () => setSparkOpen(false));

    const clock = new Date().toLocaleTimeString();

    return html`<section class=${`spark-panel window ${leaving ? "leaving" : ""}`} aria-label="Spark">
        <div class="spark-bar-head">
            <span class="spark-title"><${Icon} name="gauge" size=${14} /> Spark</span>
            <span class="spark-clock">${clock}</span>
        </div>
        <div class="spark-scroll">
            ${
                !data &&
                html`<div class="spark-notice">${error ? `Spark dashboard unreachable — ${error}` : "acquiring telemetry…"}</div>`
            }
            ${
                data &&
                (() => {
                    const [n1, n2] = nodes(data);
                    const peerUp = data.peer_state === "up";
                    const sync = new Date((data.ts || 0) * 1000).toLocaleTimeString();
                    const peerAge = Math.max(
                        0,
                        Math.round(Date.now() / 1000 - (data.peer_ts || 0)),
                    );

                    return html`<div class="spark-inner">
                        <div class="spark-bank">
                            <div class="spark-bank-h"><b>NODE 1 · BSWGX10</b><span class="spark-note"> worker</span></div>
                            <${PowerTile} s=${n1} note="0–140 W scale" />
                            <${SiliconTile} s=${n1} />
                            <${MemTile} s=${n1} />
                            <${ServeTile} s=${n1} />
                            <${SysTile} s=${n1} />
                        </div>
                        <div class="spark-bank">
                            <div class="spark-bank-h"><b>NODE 2 · BSWGX10v2</b><span class="spark-note"> ${peerUp ? "head/API · over ssh" : "unreachable"}</span></div>
                            <${PowerTile} s=${n2} note="0–140 W scale" />
                            <${SiliconTile} s=${n2} />
                            <${MemTile} s=${n2} />
                            <${ServeTile} s=${n2} />
                            <${SysTile} s=${n2} />
                        </div>
                        <${LifeTally} d=${data} />
                        <div class="spark-foot">
                            last sync ${sync} · n2 ${peerUp ? `(${peerAge}s)` : "unreachable"}${error ? ` · ${error}` : ""}
                        </div>
                    </div>`;
                })()
            }
        </div>
    </section>`;
}

/** The status line's chip: "40W · 73° · 95%", both nodes in the title, greyed when out of reach. */
export function SparkPart({ spark }) {
    if (spark === undefined) {
        return null;
    }

    if (spark === null || spark.error !== undefined) {
        return html`<span class="spark offline" title="The DGX Spark dashboard is unreachable">dgx-offline</span>`;
    }

    const peer = spark.peer_host
        ? `node2 ${Math.round(spark.peer_power_w)}W ${Math.round(spark.peer_gpu_temp)}° ${Math.round(spark.peer_gpu_util)}%`
        : "node2 offline";

    return html`<span
        class="spark"
        title=${`DGX Sparks: ${Math.round(spark.power_w)}W ${Math.round(spark.gpu_temp)}° ${Math.round(spark.gpu_util)}% · ${peer}`}
    >
        ${Math.round(spark.power_w)}W
        <span class="rest"> · ${Math.round(spark.gpu_temp)}° · ${Math.round(spark.gpu_util)}%</span>
    </span>`;
}

/** The top bar's button, quiet while closed. */
export function SparkButton() {
    const { sparkOpen } = store.state;

    return html`<button
        class=${`icon-button ${sparkOpen ? "on" : "quiet"}`}
        aria-label="Spark"
        title="Spark dashboard"
        onClick=${toggleSpark}
    >
        <${Icon} name="gauge" />
    </button>`;
}
