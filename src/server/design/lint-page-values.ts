// Plain JavaScript in a string: one part of the page script of `lint-page.ts`. The parts form one function body, so they share its locals.
export const PAGE_VALUES = String.raw`

const canvas = doc.createElement('canvas');
canvas.width = canvas.height = 1;
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const colors = new Map();
const RGB = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,\/]\s*([\d.]+%?))?\s*\)$/;

const paint = (css, back) => {
    ctx.fillStyle = back;
    ctx.fillRect(0, 0, 1, 1);
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);

    return ctx.getImageData(0, 0, 1, 1).data;
};

const viaCanvas = (css) => {
    ctx.fillStyle = '#010203';
    ctx.fillStyle = css;

    if (ctx.fillStyle === '#010203' && !/^#010203$/i.test(css)) {
        return null;
    }

    const onWhite = paint(css, '#ffffff');
    const onBlack = paint(css, '#000000');
    let alpha = 0;

    for (let channel = 0; channel < 3; channel++) {
        alpha += 1 - (onWhite[channel] - onBlack[channel]) / 255;
    }

    alpha = Math.min(1, Math.max(0, alpha / 3));

    if (alpha < 0.004) {
        return [0, 0, 0, 0];
    }

    return [0, 1, 2].map((channel) => Math.min(255, onBlack[channel] / alpha)).concat([alpha]);
};

const toRgba = (css) => {
    css = String(css);

    if (colors.has(css)) {
        return colors.get(css);
    }

    const match = RGB.exec(css);
    const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(css);
    const slash = /^(.*?)\s*\/\s*([\d.]+%?)\s*\)$/.exec(css);
    let out = null;

    if (hex) {
        // A hex color is exact; the canvas would round a faint one.
        let digits = hex[1];

        if (digits.length <= 4) digits = digits.replace(/./g, (c) => c + c);

        out = [0, 2, 4].map((at) => parseInt(digits.slice(at, at + 2), 16)).concat([digits.length === 8 ? Math.round((parseInt(digits.slice(6, 8), 16) / 255) * 100) / 100 : 1]);
    } else if (slash && !match) {
        // oklch(... / 0.07): the color from the canvas without its alpha (a faint one would lose digits), then the alpha.
        const base = viaCanvas(slash[1] + ')');
        const alpha = slash[2].endsWith('%') ? parseFloat(slash[2]) / 100 : parseFloat(slash[2]);

        out = base ? [base[0], base[1], base[2], alpha] : null;
    } else if (match) {
        const alpha = match[4] === undefined ? 1 : match[4].endsWith('%') ? parseFloat(match[4]) / 100 : parseFloat(match[4]);

        out = [Number(match[1]), Number(match[2]), Number(match[3]), alpha];
    } else {
        out = viaCanvas(css);
    }

    colors.set(css, out);

    return out;
};

const mix = (back, front, alpha) => [
    front[0] * alpha + back[0] * (1 - alpha),
    front[1] * alpha + back[1] * (1 - alpha),
    front[2] * alpha + back[2] * (1 - alpha),
];

const contrastOf = (a, b) => {
    const lum = (c) => c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    const [la, lb] = [lum(a), lum(b)].map((c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]);

    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

const rootStyle = getComputedStyle(root);
const darkCanvas = /dark/.test(rootStyle.colorScheme) && win.matchMedia('(prefers-color-scheme: dark)').matches;
const canvasRgb = darkCanvas ? [18, 18, 18] : [255, 255, 255];


const probe = doc.createElement('div');
probe.style.cssText = 'position:absolute;visibility:hidden;left:-9999px;top:0;height:0;border:0;padding:0';
body.append(probe);
const resolvedColors = input.tokenColors.map((css) => toRgba(css));
const resolvedLengths = input.tokenLengths.map((token) => {
    probe.style.fontSize = '';
    probe.style.width = '';

    if (token.kind === 'font-size') {
        probe.style.fontSize = token.css;

        return probe.style.fontSize === '' ? null : parseFloat(getComputedStyle(probe).fontSize);
    }

    probe.style.width = token.css;

    return probe.style.width === '' ? null : probe.getBoundingClientRect().width;
});
probe.remove();


const unique = (selector) => {
    try {
        return doc.querySelectorAll(selector).length === 1;
    } catch {
        return false;
    }
};
const idSelector = (el) => (el.id ? '#' + CSS.escape(el.id) : '');
const pidSelector = (value) => '[data-pid=' + JSON.stringify(value) + ']';
const step = (el) => {
    const classes = [...el.classList].filter((name) => name.length <= 30 && !/\d{3,}/.test(name)).slice(0, 2);
    let selector = el.localName + classes.map((name) => '.' + CSS.escape(name)).join('');
    const parent = el.parentElement;

    if (parent) {
        const same = [...parent.children].filter((child) => child.matches(selector));

        if (same.length > 1) {
            const ofType = [...parent.children].filter((child) => child.localName === el.localName);

            selector += ':nth-of-type(' + (ofType.indexOf(el) + 1) + ')';
        }
    }

    return selector;
};
const selectorOf = (el) => {
    if (el === root) return 'html';
    if (el === body) return 'body';
    if (el.id && unique(idSelector(el))) return idSelector(el);

    const pid = el.getAttribute('data-pid');

    if (pid && unique(pidSelector(pid))) return pidSelector(pid);

    const parts = [];

    for (let node = el; node && node.nodeType === 1 && node !== root; node = node.parentElement) {
        if (node !== el && node.id && unique(idSelector(node))) {
            parts.unshift(idSelector(node));
            break;
        }

        parts.unshift(step(node));

        if (unique(parts.join(' > '))) break;
    }

    return parts.join(' > ').slice(0, 500);
};
const infoOf = (el) => {
    const rect = el.getBoundingClientRect();
    const owner = el.closest('[data-pid]');

    return {
        selector: selectorOf(el),
        pid: owner ? owner.getAttribute('data-pid').slice(0, 200) : '',
        rect: { x: Math.round(rect.left + win.scrollX), y: Math.round(rect.top + win.scrollY), width: Math.round(rect.width), height: Math.round(rect.height) },
    };
};

// Equal values are one group for each data-pid scope: a finding can then name the element a person comments on.
const owners = new Map();
const ownerId = (el) => {
    const owner = el.closest('[data-pid]');

    if (!owner) return 0;

    if (!owners.has(owner)) owners.set(owner, owners.size + 1);

    return owners.get(owner);
};
const group = (map, key, make, el) => {
    if (map !== groups.pids) key += '@' + ownerId(el);

    let found = map.get(key);

    if (!found) {
        if (map.size >= MAX_GROUPS) return null;

        found = Object.assign({ count: 0, el }, make());
        map.set(key, found);
    }

    found.count++;

    return found;
};
const finish = (map) => [...map.values()].map((item) => Object.assign({}, item, { el: infoOf(item.el) }));

const notJudged = { count: 0, els: [] };
const groups = { colors: new Map(), fonts: new Map(), sizes: new Map(), contrast: new Map(), targets: new Map(), images: new Map(), pids: new Map(), labels: new Map(), names: new Map(), zoom: new Map() };
const headings = [];


// What the author set. A value that the browser gives an element by itself (a button's border and padding, a heading's
// size, black text) is not the page's, and is not judged. Each tag's defaults are read from a probe of the same tag in
// a shadow tree, where the page's style sheets do not reach.

const probeHost = doc.createElement('div');
probeHost.style.cssText = 'all:initial;display:block;position:absolute;visibility:hidden;left:-9999px;top:0;color-scheme:' + (rootStyle.colorScheme || 'normal');
const probeRoot = probeHost.attachShadow({ mode: 'closed' });
// Not in the body, so that the walk does not see it.
root.append(probeHost);
const UA_PROPS = ['color', 'backgroundColor', 'fontSize', 'fontFamily', 'outlineColor', 'rowGap', 'columnGap'];

for (const side of ['Top', 'Right', 'Bottom', 'Left']) UA_PROPS.push('border' + side + 'Color', 'border' + side + 'Width', 'border' + side + 'Style', 'padding' + side, 'margin' + side);

for (const corner of ['TopLeft', 'TopRight', 'BottomRight', 'BottomLeft']) UA_PROPS.push('border' + corner + 'Radius');

const defaults = new Map();
const defaultsOf = (el, parentPx) => {
    const key = el.localName + '|' + (el.localName === 'input' ? el.type : '') + '|' + el.hasAttribute('href') + '|' + parentPx;

    if (!defaults.has(key)) {
        // The browser's default size is a keyword (medium), not 16px: a monospace element is 13px only on the keyword.
        probeHost.style.fontSize = parentPx === 16 ? '' : parentPx + 'px';
        const probe = doc.createElement(el.localName);

        if (el.localName === 'input') probe.setAttribute('type', el.type);

        if (el.hasAttribute('href')) probe.setAttribute('href', '#');

        probeRoot.append(probe);
        const look = getComputedStyle(probe);
        const out = {};

        for (const prop of UA_PROPS) out[prop] = look[prop];

        probe.remove();
        defaults.set(key, out);
    }

    return defaults.get(key);
};
const parentPx = (el) => parseFloat(getComputedStyle(el.parentElement || el).fontSize) || 16;
const LENGTH_PROP = /^(padding|margin|rowGap|columnGap|border.*Radius)/;

// A property that is not inherited: set by the author when it is not what the tag has by default. A length that is
// the same number of ems as the default (a paragraph's margin) is the default too.
// Without the page's rules (a sheet from another site cannot be read), the markup's own presentation attributes
// (font color, bgcolor, a table's cellpadding) must not be mistaken for CSS.
const legacyMarkup = (el) => el.matches('font,[bgcolor]') || (/^(table|thead|tbody|tfoot|tr|td|th|caption)$/.test(el.localName) && el.closest('table[border],table[cellpadding],table[cellspacing],table[bgcolor]') !== null);
const authoredOwn = (el, prop, style) => {
    // With every rule of the page known, "set by the author" is a fact about the rules: one that matches the element, or
    // its style attribute, sets the property. Otherwise the browser's defaults stand in for it.
    if (declarationsKnown) return declaredOwn(el, prop);

    if (legacyMarkup(el)) return false;

    const wanted = defaultsOf(el, parentPx(el));

    if (style[prop] === wanted[prop]) return false;

    if (LENGTH_PROP.test(prop)) {
        const ratio = (value, size) => parseFloat(value) / (parseFloat(size) || 16);

        if (Math.abs(ratio(style[prop], style.fontSize) - ratio(wanted[prop], wanted.fontSize)) < 0.01) return false;
    }

    return true;
};

const inheritedMemo = new Map();
const inheritedAuthored = (el, prop) => {
    const style = getComputedStyle(el);
    const parent = el.parentElement;

    if (declarationsKnown) {
        // Set on the element by a rule, or inherited from an ancestor that set it; a value that differs from the
        // parent's with no rule of the page behind it is the browser's (a link's blue).
        if (declaredOwn(el, prop)) return true;

        return parent !== null && style[prop] === getComputedStyle(parent)[prop] && inheritedAuthored(parent, prop);
    }

    if (legacyMarkup(el)) return false;

    if (!parent) return style[prop] !== defaultsOf(doc.createElement('div'), 16)[prop];

    const memo = inheritedMemo.get(el);

    if (memo && prop in memo) return memo[prop];

    let answer;

    if (style[prop] === getComputedStyle(parent)[prop]) answer = inheritedAuthored(parent, prop);
    else answer = style[prop] !== defaultsOf(el, parentPx(el))[prop];

    inheritedMemo.set(el, Object.assign(memo || {}, { [prop]: answer }));

    return answer;
};
`;
