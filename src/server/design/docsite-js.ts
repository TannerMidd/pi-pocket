import { SANITIZER_JS } from "./docsite-sanitize.ts";

/** Runs first, in the head, so the page opens in the mode the visitor's color scheme asks for, with no flash. */
export const DOC_BOOT_JS = `(function(){try{var r=document.documentElement,m=r.getAttribute("data-dark-mode");if(m&&window.matchMedia&&matchMedia("(prefers-color-scheme: dark)").matches){r.setAttribute("data-mode",m);r.setAttribute("data-theme","dark")}}catch(e){}})();`;

export const DOC_JS = `
(function () {
    "use strict";
    var root = document.documentElement;
    root.classList.remove("nojs");
    var $ = function (selector, scope) { return (scope || document).querySelector(selector); };
    var $$ = function (selector, scope) { return Array.prototype.slice.call((scope || document).querySelectorAll(selector)); };
    var toastEl = $(".toast");
    var toastTimer = 0;

    function toast(text) {
        toastEl.textContent = text;
        toastEl.classList.add("show");
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { toastEl.classList.remove("show"); }, 1400);
    }

    function copyText(text) {
        function fallback() {
            var area = document.createElement("textarea");
            area.value = text;
            area.style.position = "fixed";
            area.style.opacity = "0";
            document.body.appendChild(area);
            area.select();
            var done = false;
            try { done = document.execCommand("copy"); } catch (error) { done = false; }
            area.remove();
            return done;
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
            return navigator.clipboard.writeText(text).then(function () { return true; }, fallback);
        }
        return Promise.resolve(fallback());
    }

    document.addEventListener("click", function (event) {
        var link = event.target.closest && event.target.closest("a.anchor");
        if (link) {
            copyText(location.href.split("#")[0] + link.getAttribute("href")).then(function (ok) { toast(ok ? "Copied the link" : "Could not copy the link"); });
            return;
        }
        var target = event.target.closest && event.target.closest("[data-copy], [data-copy-from], .tk");
        if (!target) { return; }
        var text = target.getAttribute("data-copy") || target.textContent.trim();
        if (target.hasAttribute("data-copy-from")) {
            var source = document.getElementById(target.getAttribute("data-copy-from"));
            text = source ? source.textContent : "";
        }
        if (!text) { return; }
        copyText(text).then(function (ok) {
            toast(ok ? "Copied " + (text.length > 40 ? "to the clipboard" : text) : "Could not copy");
            target.classList.add("flash");
            setTimeout(function () { target.classList.remove("flash"); }, 900);
        });
    });

    function setMode(mode, theme) {
        root.setAttribute("data-mode", mode);
        root.setAttribute("data-theme", theme);
        $$(".seg button").forEach(function (button) { button.setAttribute("aria-pressed", String(button.getAttribute("data-mode") === mode)); });
        var picker = $(".modesel");
        if (picker) { picker.value = mode; }
    }
    $$(".seg button").forEach(function (button) {
        button.addEventListener("click", function () { setMode(button.getAttribute("data-mode"), button.getAttribute("data-theme")); });
    });
    var select = $(".modesel");
    if (select) {
        select.addEventListener("change", function () { setMode(select.value, select.options[select.selectedIndex].getAttribute("data-theme")); });
    }
    setMode(root.getAttribute("data-mode"), root.getAttribute("data-theme"));

    var menuButton = $(".icon-btn");
    function navOpen(open) {
        root.classList.toggle("nav-open", open);
        menuButton.setAttribute("aria-expanded", String(open));
    }
    menuButton.addEventListener("click", function () { navOpen(!root.classList.contains("nav-open")); });
    $$(".nav a").forEach(function (link) { link.addEventListener("click", function () { navOpen(false); }); });

    // A row hides when either filter leaves it out: the page's filter (__g) or the token table's own (__l).
    var field = $("#q");
    var emptyEl = $("#nomatch");
    var wordsOf = function (text) { return text.trim().toLowerCase().split(/\\s+/).filter(Boolean); };
    var hits = function (item, words) {
        var text = item.__q || (item.__q = item.textContent.toLowerCase());
        return words.every(function (word) { return text.indexOf(word) !== -1; });
    };
    function filterPage() {
        var words = wordsOf(field.value);
        var shown = 0;
        $$("[data-s]").forEach(function (item) {
            item.__g = !hits(item, words);
            item.hidden = item.__g || !!item.__l;
            if (!item.__g) { shown++; }
        });
        $$("[data-group], section.block[data-searchable]").forEach(function (group) {
            group.hidden = words.length > 0 && !$("[data-s]:not([hidden])", group);
        });
        emptyEl.hidden = !(words.length > 0 && shown === 0);
        filterTable();
    }
    field.addEventListener("input", filterPage);
    document.addEventListener("keydown", function (event) {
        if (event.key === "Escape") { navOpen(false); }
        if (event.key === "/" && !/input|textarea|select/i.test((document.activeElement || {}).tagName || "")) {
            event.preventDefault();
            navOpen(true);
            field.focus();
        }
    });

    var tableRows = $$("#token-table tbody tr");
    var tableSearch = $("#tq");
    var tableType = $("#tt");
    var tableTier = $("#tr");
    function filterTable() {
        var words = wordsOf(tableSearch.value);
        var shown = 0;
        tableRows.forEach(function (row) {
            row.__l = !((!tableType.value || row.getAttribute("data-type") === tableType.value) && (!tableTier.value || row.getAttribute("data-tier") === tableTier.value) && hits(row, words));
            row.hidden = !!row.__g || row.__l;
            if (!row.hidden) { shown++; }
        });
        var filtering = shown < tableRows.length;
        $("#tc").textContent = filtering ? shown + " of " + tableRows.length : tableRows.length + " tokens";
    }
    tableSearch.addEventListener("input", filterTable);
    tableType.addEventListener("change", filterTable);
    tableTier.addEventListener("change", filterTable);

    var links = {};
    $$(".nav a[href^='#']").forEach(function (link) { links[link.getAttribute("href").slice(1)] = link; });
    if ("IntersectionObserver" in window) {
        var current = "overview";
        var observer = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
                var id = entry.target.id;
                if (!entry.isIntersecting || !links[id] || id === current) { return; }
                if (links[current]) { links[current].removeAttribute("aria-current"); }
                links[id].setAttribute("aria-current", "true");
                current = id;
            });
        }, { rootMargin: "-20% 0px -70% 0px" });
        $$("main section[id], main article.comp[id]").forEach(function (section) { observer.observe(section); });
    }

    function openHash() {
        var id = "";
        try { id = decodeURIComponent(location.hash.slice(1)); } catch (error) { id = ""; }
        var target = id ? document.getElementById(id) : null;
        if (!target) { return; }
        for (var node = target; node && node !== document.body; node = node.parentElement) {
            if (node.tagName === "DETAILS") { node.open = true; }
        }
        target.scrollIntoView();
    }
    window.addEventListener("hashchange", openHash);
    if (location.hash) { openHash(); }

    $$(".demo .play").forEach(function (button) {
        button.addEventListener("click", function () { button.closest(".demo").classList.toggle("on"); });
    });

    // Component states are project text. Each is parsed in an inert document (nothing in it runs or loads), and a new
    // tree is built from what the allowlist names (docsite-sanitize.ts). It goes in a shadow root inside a box that
    // clips it and holds any fixed position: the component's CSS stays in, the page's stays out, and the custom
    // properties of the tokens come in.
    ${SANITIZER_JS}
    var STAGE_CSS = "*{box-sizing:border-box}.__w{overflow:hidden}.__g{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,300px),1fr));margin:0 -1px -1px 0}.__c{min-width:0;padding:16px 18px 20px;box-shadow:inset -1px -1px 0 rgb(128 128 128/.28)}.__l{margin:0 0 14px;font:600 11px/1 ui-monospace,Menlo,Consolas,monospace;letter-spacing:.08em;text-transform:uppercase;opacity:.62}";
    $$(".comp-stage").forEach(function (stage) {
        if (!document.body.attachShadow) { return; }
        var css = "";
        var wrap = document.createElement("div");
        var grid = document.createElement("div");
        wrap.className = "__w";
        grid.className = "__g";
        $$(".snip[data-kind]", stage.closest("article")).forEach(function (panel) {
            var code = $("pre", panel).textContent;
            if (panel.getAttribute("data-kind") === "css") { css = code; return; }
            var cell = document.createElement("div");
            var label = document.createElement("p");
            cell.className = "__c";
            label.className = "__l";
            label.textContent = panel.getAttribute("data-panel");
            cell.appendChild(label);
            cleanInto(new DOMParser().parseFromString(code, "text/html"), cell);
            grid.appendChild(cell);
        });
        var host = document.createElement("div");
        host.className = "comp-host";
        stage.textContent = "";
        stage.appendChild(host);
        var shadow = host.attachShadow({ mode: "open" });
        var style = document.createElement("style");
        style.textContent = STAGE_CSS + cleanCss(css);
        wrap.appendChild(grid);
        shadow.appendChild(style);
        shadow.appendChild(wrap);
        shadow.addEventListener("click", function (event) {
            if (event.composedPath().some(function (node) { return node.localName === "a"; })) { event.preventDefault(); }
        });
        shadow.addEventListener("submit", function (event) { event.preventDefault(); });
        stage.setAttribute("data-ready", "");
    });
    // A capture (design_preview, a PDF) can wait for this: every state is drawn in the page itself.
    root.setAttribute("data-docs-ready", "");
})();
`;
