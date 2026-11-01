// Runs in an isolated world, so the page's own scripts cannot change what it uses. A value that
// is the same with and without the author's styles is the browser's own, and is left out.

export type Weights = Record<string, number>;

export interface Reading {
    vars: Record<string, string>;
    page: { bg: string; text: string; bgAuthored: boolean; textAuthored: boolean };
    count: number;
    // Weighed by area in px² ÷ 100.
    bg: Record<string, Weights>;
    // Weighed by characters.
    text: Record<string, Weights>;
    border: Weights;
    radius: Weights;
    shadow: Weights;
    font: Record<string, Weights>;
    size: Record<string, Weights>;
    space: Weights;
    status: Record<string, { bg: Weights; text: Weights; border: Weights }>;
    buttons: { bg: string; color: string; area: number; primary: boolean }[];
}

export interface ProbeInput {
    vars: string[];
    bare: boolean;
}

// Reads at most 2,500 elements and keeps the 60 heaviest values of each kind.
export const PROBE_SOURCE = String.raw`(input) => {
    const root = document.documentElement;
    const body = document.body;
    const MAX = 2500;
    const keep = (weights, limit = 60) => {
        const entries = Object.entries(weights).sort((a, b) => b[1] - a[1]).slice(0, limit);
        return Object.fromEntries(entries.map(([key, value]) => [key, Math.round(value * 10) / 10]));
    };
    const add = (target, key, by) => {
        if (key === undefined || key === '' || key.length > 400) return;
        target[key] = (target[key] ?? 0) + by;
    };
    const opaque = (color) => {
        if (!color || color === 'transparent') return false;
        const m = /^rgba?\(([^)]*)\)$/.exec(color);
        if (m) {
            const parts = m[1].split(/[,/\s]+/).filter(Boolean);
            return parts.length < 4 || Number(parts[3]) > 0.04;
        }
        return !/\/\s*0(\.0+)?%?\s*\)$/.test(color);
    };
    const words = (el) => {
        const text = ((typeof el.className === 'string' ? el.className : '') + ' ' + (el.id || '')).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
        return new Set(text.split(/[^a-z0-9]+/).filter(Boolean));
    };
    const has = (set, list) => list.some((word) => set.has(word));
    const bgKind = (el, set) => {
        const tag = el.localName;
        if (/^(button)$/.test(tag) || el.getAttribute('role') === 'button' || has(set, ['btn', 'button', 'cta'])) return 'button';
        if (/^(input|select|textarea)$/.test(tag) || has(set, ['input', 'field', 'select', 'textarea'])) return 'input';
        if (has(set, ['alert', 'toast', 'notice', 'banner', 'callout', 'message'])) return 'alert';
        if (has(set, ['badge', 'chip', 'pill', 'tag', 'label', 'status'])) return 'badge';
        if (has(set, ['card', 'panel', 'tile', 'box', 'surface', 'modal', 'dialog', 'popover', 'drawer', 'dropdown', 'menu', 'sheet', 'paper', 'well', 'pane', 'widget']) || tag === 'dialog' || tag === 'article' || tag === 'aside') return 'card';
        if (/^(code|pre|kbd|samp)$/.test(tag)) return 'code';
        if (/^(nav|header)$/.test(tag) || has(set, ['nav', 'navbar', 'header', 'topbar', 'toolbar', 'appbar', 'sidebar'])) return 'nav';
        if (tag === 'footer' || has(set, ['footer'])) return 'footer';
        if (/^(table|thead|tbody|tr|td|th)$/.test(tag)) return 'table';
        if (/^(section|main|div|form|ul|ol|li|details|fieldset)$/.test(tag)) return 'block';
        return 'other';
    };
    const textKind = (el, set) => {
        const tag = el.localName;
        if (/^h[1-6]$/.test(tag) || has(set, ['title', 'heading', 'headline', 'display', 'hero'])) return 'heading';
        if (tag === 'a' || has(set, ['link'])) return 'link';
        if (tag === 'button' || has(set, ['btn', 'button'])) return 'button';
        if (/^(code|pre|kbd|samp)$/.test(tag)) return 'code';
        if (has(set, ['muted', 'secondary', 'subtle', 'caption', 'hint', 'help', 'meta', 'dim', 'faint', 'placeholder', 'footnote', 'description', 'subtitle', 'sub', 'lede', 'lead', 'eyebrow', 'quiet', 'tertiary', 'weak', 'soft']) || /^(small|figcaption|caption|label|time|cite)$/.test(tag)) return 'muted';
        return 'body';
    };
    // The browser's own link colors, in a light page and in a dark one.
    const UA_LINK = new Set(['rgb(0, 0, 238)', 'rgb(158, 158, 255)', 'rgb(85, 26, 139)', 'rgb(208, 173, 240)']);
    const STATUS = [
        ['danger', ['error', 'danger', 'invalid', 'fail', 'failed', 'failure', 'negative', 'destructive', 'critical', 'alert-danger', 'err']],
        ['warning', ['warning', 'warn', 'caution', 'attention', 'pending']],
        ['success', ['success', 'valid', 'positive', 'ok', 'done', 'complete', 'completed', 'passed', 'active', 'online']],
    ];
    const px = (value) => {
        const number = parseFloat(value);
        return Number.isFinite(number) ? number : 0;
    };
    const shown = (el) => {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return undefined;
        const box = el.getBoundingClientRect();
        if (box.width < 1 || box.height < 1) return undefined;
        return { style, box };
    };
    const tuple = (el, style) => ({
        bg: style.backgroundColor,
        color: style.color,
        border: ['Top', 'Right', 'Bottom', 'Left'].map((side) => style['border' + side + 'Style'] !== 'none' && px(style['border' + side + 'Width']) > 0 ? style['border' + side + 'Color'] : '').join('|'),
        bw: ['Top', 'Right', 'Bottom', 'Left'].map((side) => style['border' + side + 'Style'] !== 'none' ? px(style['border' + side + 'Width']) : 0).join('|'),
        radius: style.borderTopLeftRadius,
        shadow: style.boxShadow,
        family: style.fontFamily,
        size: style.fontSize,
        space: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft, style.marginTop, style.marginBottom, style.rowGap, style.columnGap].join('|'),
    });
    const elements = Array.from(document.querySelectorAll('body, body *')).filter((el) => !/^(script|style|link|meta|noscript|template|svg|path|defs|title)$/.test(el.localName)).slice(0, MAX * 2);
    const visible = [];
    for (const el of elements) {
        const seen = shown(el);
        if (seen !== undefined) visible.push([el, seen.box, tuple(el, seen.style)]);
        if (visible.length >= MAX) break;
    }
    const bare = new Map();
    let bareRoot;
    if (input.bare) {
        const sheets = Array.from(document.styleSheets);
        const flags = sheets.map((sheet) => sheet.disabled);
        const adopted = document.adoptedStyleSheets;
        const inline = visible.map(([el]) => el.getAttribute('style'));
        sheets.forEach((sheet) => { sheet.disabled = true; });
        try { document.adoptedStyleSheets = []; } catch {}
        visible.forEach(([el]) => { if (el.hasAttribute('style')) el.removeAttribute('style'); });
        visible.forEach(([el]) => { bare.set(el, tuple(el, getComputedStyle(el))); });
        bareRoot = tuple(root, getComputedStyle(root));
        sheets.forEach((sheet, at) => { sheet.disabled = flags[at]; });
        try { document.adoptedStyleSheets = adopted; } catch {}
        visible.forEach(([el], at) => { if (inline[at] !== null) el.setAttribute('style', inline[at]); });
    }
    const out = {
        vars: {},
        page: { bg: '', text: '', bgAuthored: true, textAuthored: true },
        count: visible.length,
        bg: {}, text: {}, border: {}, radius: {}, shadow: {}, font: {}, size: {}, space: {}, status: {}, buttons: [],
    };
    const rootStyle = getComputedStyle(root);
    for (const name of input.vars.slice(0, 900)) {
        const value = rootStyle.getPropertyValue(name).trim();
        if (value !== '' && value.length < 400) out.vars[name] = value;
    }
    const bodyStyle = getComputedStyle(body);
    out.page.bg = opaque(bodyStyle.backgroundColor) ? bodyStyle.backgroundColor : opaque(rootStyle.backgroundColor) ? rootStyle.backgroundColor : 'rgb(255, 255, 255)';
    out.page.text = bodyStyle.color;
    if (input.bare) {
        const bareBody = bare.get(body);
        const bodyBg = bareBody !== undefined && opaque(bodyStyle.backgroundColor) && bareBody.bg !== bodyStyle.backgroundColor;
        const rootBg = bareRoot !== undefined && opaque(rootStyle.backgroundColor) && bareRoot.bg !== rootStyle.backgroundColor;
        out.page.bgAuthored = bodyBg || rootBg;
        out.page.textAuthored = bareBody !== undefined && bareBody.color !== bodyStyle.color;
    }
    const ensure = (map, key) => (map[key] ??= {});
    for (const [el, box, now] of visible) {
        const was = input.bare ? bare.get(el) : undefined;
        const same = (key) => was !== undefined && was[key] === now[key];
        const set = words(el);
        const area = Math.min(box.width * box.height, 4e6) / 100;
        if (opaque(now.bg) && !same('bg')) {
            const kind = el === body || el === root ? 'page' : bgKind(el, set);
            add(ensure(out.bg, kind), now.bg, area);
        }
        let chars = 0;
        for (const node of el.childNodes) if (node.nodeType === 3) chars += node.textContent.trim().length;
        if (chars > 0) {
            const kind = textKind(el, set);
            if (!same('color') && !(kind === 'link' && UA_LINK.has(now.color))) add(ensure(out.text, kind), now.color, chars);
            if (!same('family')) add(ensure(out.font, /^(code|pre|kbd|samp)$/.test(el.localName) ? 'code' : kind === 'heading' ? 'heading' : 'body'), now.family, chars);
            if (!(same('size') && /^h[1-6]$/.test(el.localName))) add(ensure(out.size, kind === 'heading' ? 'heading' : 'body'), now.size, chars);
        }
        if (now.border !== '' && (!same('border') || !same('bw'))) {
            const colors = now.border.split('|').filter(Boolean);
            if (colors.length > 0 && opaque(colors[0])) add(out.border, colors[0], 1 + Math.min(area / 40, 4));
        }
        if (px(now.radius) > 0 && !same('radius')) add(out.radius, now.radius, 1);
        if (now.shadow !== 'none' && !same('shadow')) add(out.shadow, now.shadow, 1);
        if (!same('space')) {
            for (const part of now.space.split('|')) {
                const value = px(part);
                if (value >= 1 && value <= 200 && /px$/.test(part)) add(out.space, String(Math.round(value * 100) / 100), 1);
            }
        }
        for (const [status, list] of STATUS) {
            if (has(set, list)) {
                const entry = (out.status[status] ??= { bg: {}, text: {}, border: {} });
                if (opaque(now.bg) && !same('bg')) add(entry.bg, now.bg, area);
                if (!same('color')) add(entry.text, now.color, Math.max(chars, 1));
                if (now.border !== '' && !same('border') && opaque(now.border.split('|').find(Boolean) || '')) add(entry.border, now.border.split('|').find(Boolean), 1);
            }
        }
        if ((el.localName === 'button' || el.getAttribute('role') === 'button' || has(set, ['btn', 'button', 'cta']) || (el.localName === 'input' && /^(submit|button)$/.test(el.getAttribute('type') || ''))) && opaque(now.bg) && !same('bg') && out.buttons.length < 40) {
            out.buttons.push({ bg: now.bg, color: same('color') ? '' : now.color, area, primary: has(set, ['primary', 'brand', 'main', 'cta', 'accent', 'submit', 'default']) });
        }
    }
    for (const key of ['bg', 'text', 'font', 'size']) {
        for (const kind of Object.keys(out[key])) out[key][kind] = keep(out[key][kind]);
    }
    for (const key of ['border', 'radius', 'shadow', 'space']) out[key] = keep(out[key]);
    for (const status of Object.keys(out.status)) for (const key of ['bg', 'text', 'border']) out.status[status][key] = keep(out.status[status][key], 8);
    return out;
}`;
