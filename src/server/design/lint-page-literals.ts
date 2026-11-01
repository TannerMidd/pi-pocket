// Plain JavaScript in a string: one part of the page script of `lint-page.ts`. The parts form one function body, so they share its locals.
export const PAGE_LITERALS = String.raw`
// Authored literals. With a system, a color, length, or font written as a literal in the page's own CSS is hard-coded
// even when its value equals a token: it does not follow the token. The page's rules say which values were authored (a
// computed value cannot): the colors, lengths, and font families that they set without var().

const literalRules = [];
const KEEP_WORDS = new Set(['transparent', 'currentcolor', 'inherit', 'initial', 'unset', 'revert', 'revert-layer', 'none', 'auto', 'canvas', 'canvastext', 'buttonface', 'buttontext', 'buttonborder', 'field', 'fieldtext', 'highlight', 'highlighttext', 'linktext', 'visitedtext', 'activetext', 'graytext', 'mark', 'marktext', 'accentcolor', 'accentcolortext', 'selecteditem', 'selecteditemtext']);
const stripVars = (text) => {
    let out = '';

    for (let i = 0; i < text.length; ) {
        if (text.startsWith('var(', i)) {
            let depth = 0;
            let j = i + 3;

            for (; j < text.length; j++) {
                if (text[j] === '(') depth++;
                else if (text[j] === ')' && --depth === 0) break;
            }

            out += ' ';
            i = j + 1;
        } else {
            out += text[i++];
        }
    }

    return out;
};
const colorWords = (text) => {
    const found = [];
    const pattern = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^()]*\)|[a-z][a-z-]*/gi;

    for (const match of stripVars(text).matchAll(pattern)) {
        const word = match[0];

        if (/^[a-z]/i.test(word) && !word.includes('(') && (KEEP_WORDS.has(word.toLowerCase()) || !CSS.supports('color', word))) continue;

        found.push(word);
    }

    return found;
};
const lengthWords = (text) => [...stripVars(text).matchAll(/(-?\d*\.?\d+)(px|rem|em|pt)\b/gi)].map((m) => ({ value: Number(m[1]), unit: m[2].toLowerCase() }));
const splitDecls = (cssText) => {
    const out = [];
    let depth = 0;
    let quote = '';
    let start = 0;

    for (let i = 0; i <= cssText.length; i++) {
        const ch = cssText[i];

        if (quote) {
            if (ch === quote) quote = '';
        } else if (ch === '"' || ch === "'") quote = ch;
        else if (ch === '(') depth++;
        else if (ch === ')') depth--;
        else if ((ch === ';' && depth === 0) || i === cssText.length) {
            const text = cssText.slice(start, i);
            const colon = text.indexOf(':');

            if (colon > 0) out.push([text.slice(0, colon).trim().toLowerCase(), text.slice(colon + 1).replace(/!important\s*$/i, '').trim()]);

            start = i + 1;
        }
    }

    return out;
};
const partsOf = (cssText) => {
    const parts = { text: [], background: [], border: [], outline: [], 'font-size': [], space: [], radius: [], family: [] };
    let any = false;
    const put = (kind, list) => {
        if (list.length > 0) {
            parts[kind].push(...list);
            any = true;
        }
    };

    for (const [prop, value] of splitDecls(cssText)) {
        if (prop.startsWith('--')) continue;

        if (prop === 'color' || prop === '-webkit-text-fill-color') put('text', colorWords(value));
        else if (prop === 'background' || prop === 'background-color') put('background', colorWords(value));
        else if (/^border(-(top|right|bottom|left|block|inline)(-(start|end))?)?(-color)?$/.test(prop)) put('border', colorWords(value));
        else if (prop === 'outline' || prop === 'outline-color') put('outline', colorWords(value));
        else if (prop === 'font-size') put('font-size', lengthWords(value));
        else if (prop === 'font') put('font-size', lengthWords(value).slice(0, 1));
        else if (/^(padding|margin)(-(top|right|bottom|left|block|inline)(-(start|end))?)?$/.test(prop) || /^(grid-)?(row-|column-)?gap$/.test(prop)) put('space', lengthWords(value));
        else if (/^border(-(top|bottom)-(left|right))?-radius$/.test(prop)) put('radius', lengthWords(value));
        else if (prop === 'font-family' && !value.includes('var(')) put('family', [value]);
    }

    return any ? parts : null;
};

const allRules = [];
const byId = new Map();
const byClass = new Map();
const byTag = new Map();
const general = [];
let unreadableSheet = false;
let capHit = false;
const declaredNames = (cssText) => new Set(splitDecls(cssText).map(([prop]) => prop).filter((prop) => !prop.startsWith('--')));
const indexRule = (rule) => {
    const keys = [];

    for (const part of rule.selector.split(/,(?![^(\[]*[)\]])/)) {
        const last = part.trim().split(/\s*[>+~]\s*|\s+(?![^(\[]*[)\]])/).pop() || '';
        const id = /#([\w-]+)/.exec(last);
        const klass = /\.([\w-]+)/.exec(last);
        const tag = /^([a-z][\w-]*)/i.exec(last);

        keys.push(part.includes('&') || /^[:*\[]/.test(last) && !id && !klass ? ['*'] : id ? ['#', id[1]] : klass ? ['.', klass[1]] : tag ? ['t', tag[1].toLowerCase()] : ['*']);
    }

    for (const [kind, name] of keys) {
        const map = kind === '#' ? byId : kind === '.' ? byClass : kind === 't' ? byTag : null;

        if (!map) general.push(rule);
        else {
            if (!map.has(name)) map.set(name, []);
            map.get(name).push(rule);
        }
    }
};

if (input.literals === true) {
    const walk = (rules) => {
        for (const rule of rules) {
            if (allRules.length >= 4000) {
                capHit = true;

                return;
            }

            if (rule.type === 1) {
                const entry = { selector: rule.selectorText, parts: partsOf(rule.style.cssText), declared: declaredNames(rule.style.cssText) };

                allRules.push(entry);
                indexRule(entry);

                if (entry.parts) literalRules.push(entry);
            } else if (rule.type === 3 && rule.styleSheet) {
                try {
                    walk(rule.styleSheet.cssRules);
                } catch {
                    unreadableSheet = true;
                }
            } else if (rule.cssRules && (rule.type === 4 ? win.matchMedia(rule.conditionText || rule.media.mediaText).matches : rule.type === 12 ? CSS.supports(rule.conditionText) : true)) {
                walk(rule.cssRules);
            }
        }
    };

    for (const rules of sheetRules) walk(rules);

    // A sheet that could not be read at all (another site's): the rules are not all known.
    unreadableSheet = sheetsUnreadable;
}

const declarationsKnown = input.literals === true && !unreadableSheet && !capHit;
const matchedCache = new Map();
const matchedRules = (el) => {
    if (matchedCache.has(el)) return matchedCache.get(el);

    const candidates = new Set(general);

    for (const rule of byTag.get(el.localName) || []) candidates.add(rule);

    if (el.id) for (const rule of byId.get(el.id) || []) candidates.add(rule);

    for (const name of el.classList) for (const rule of byClass.get(name) || []) candidates.add(rule);

    const matched = [...candidates].filter((rule) => {
        try {
            return el.matches(rule.selector);
        } catch {
            return false;
        }
    });

    matchedCache.set(el, matched);

    return matched;
};

// The CSS properties that set one property (a camelCase one, as in computed styles): the longhand itself, the shorthands
// that carry it, and the logical forms of its side. A shorthand family is not enough: the author who sets margin-top
// has not set margin-bottom, and the paragraph's own margin there is the browser's.
const SIDES = { Top: ['top', 'block-start'], Bottom: ['bottom', 'block-end'], Left: ['left', rootStyle.direction === 'rtl' ? 'inline-end' : 'inline-start'], Right: ['right', rootStyle.direction === 'rtl' ? 'inline-start' : 'inline-end'] };
const CORNERS = { TopLeft: ['top-left', 'start-start'], TopRight: ['top-right', 'start-end'], BottomRight: ['bottom-right', 'end-end'], BottomLeft: ['bottom-left', 'end-start'] };
const kebab = (name) => name.replace(/([A-Z])/g, (m) => '-' + m.toLowerCase());
const settersCache = new Map();
const settersOf = (prop) => {
    if (settersCache.has(prop)) return settersCache.get(prop);

    const names = new Set(['all', kebab(prop)]);
    let match;

    if ((match = /^(padding|margin)(Top|Right|Bottom|Left)$/.exec(prop))) {
        const [family, side] = [match[1], match[2]];
        const [physical, logical] = SIDES[side];
        const axis = side === 'Top' || side === 'Bottom' ? 'block' : 'inline';

        for (const name of [family, family + '-' + physical, family + '-' + logical, family + '-' + axis]) names.add(name);
    } else if ((match = /^border(Top|Right|Bottom|Left)(Color|Width|Style)$/.exec(prop))) {
        const [side, kind] = [match[1], match[2].toLowerCase()];
        const [physical, logical] = SIDES[side];
        const axis = side === 'Top' || side === 'Bottom' ? 'block' : 'inline';

        for (const base of ['border', 'border-' + physical, 'border-' + logical, 'border-' + axis]) {
            names.add(base);
            names.add(base + '-' + kind);
        }

        names.add('border-' + kind);
    } else if ((match = /^border(TopLeft|TopRight|BottomRight|BottomLeft)Radius$/.exec(prop))) {
        for (const name of ['border-radius', 'border-' + CORNERS[match[1]][0] + '-radius', 'border-' + CORNERS[match[1]][1] + '-radius']) names.add(name);
    } else if (prop === 'rowGap') {
        for (const name of ['gap', 'row-gap', 'grid-gap', 'grid-row-gap']) names.add(name);
    } else if (prop === 'columnGap') {
        for (const name of ['gap', 'column-gap', 'grid-gap', 'grid-column-gap']) names.add(name);
    } else if (prop === 'outlineColor') {
        names.add('outline');
    } else if (prop === 'backgroundColor') {
        names.add('background');
    } else if (prop === 'fontSize' || prop === 'fontFamily') {
        names.add('font');
    }

    settersCache.set(prop, names);

    return names;
};

const declaredMemo = new Map();
const declaredOwn = (el, prop) => {
    const memo = declaredMemo.get(el) || {};

    if (prop in memo) return memo[prop];

    const setters = settersOf(prop);
    let found = matchedRules(el).some((rule) => [...rule.declared].some((name) => setters.has(name)));

    if (!found && el.hasAttribute('style')) found = [...declaredNames(el.getAttribute('style'))].some((name) => setters.has(name));

    declaredMemo.set(el, Object.assign(memo, { [prop]: found }));

    return found;
};

const literalCache = new Map();
const literalsOf = (el) => {
    if (literalCache.has(el)) return literalCache.get(el);

    const merged = { text: [], background: [], border: [], outline: [], 'font-size': [], space: [], radius: [], family: [] };
    const lists = matchedRules(el).filter((rule) => rule.parts).map((rule) => rule.parts);
    const inline = el.hasAttribute('style') && input.literals === true ? partsOf(el.getAttribute('style')) : null;

    for (const parts of inline ? [...lists, inline] : lists) {
        for (const kind of Object.keys(merged)) merged[kind].push(...parts[kind]);
    }

    literalCache.set(el, merged);

    return merged;
};
const sameColor = (a, b) => Math.abs(a[0] - b[0]) <= 1.5 && Math.abs(a[1] - b[1]) <= 1.5 && Math.abs(a[2] - b[2]) <= 1.5 && Math.abs(a[3] - b[3]) <= 0.02;
const authoredColor = (el, role, rgba) => literalsOf(el)[role].some((css) => {
    const other = toRgba(css);

    return other && sameColor(other, rgba);
});
const rootPx = parseFloat(rootStyle.fontSize) || 16;
const authoredLength = (el, kind, px, style) => literalsOf(el)[kind].some((item) => {
    const base = item.unit === 'px' ? 1 : item.unit === 'pt' ? 4 / 3 : item.unit === 'rem' ? rootPx : kind === 'font-size' ? parseFloat(getComputedStyle(el.parentElement || el).fontSize) || rootPx : parseFloat(style.fontSize) || rootPx;

    return Math.abs(Math.abs(item.value) * base - px) <= 0.5;
});
const authoredFamily = (el, family) => literalsOf(el).family.some((list) => familyOf(list) === family);
`;
