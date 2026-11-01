// Plain JavaScript in a string: one part of the page script of `lint-page.ts`. The parts form one function body, so they share its locals.
export const PAGE_STATES = String.raw`

const SKIP = new Set(['HEAD', 'SCRIPT', 'STYLE', 'META', 'LINK', 'TITLE', 'NOSCRIPT', 'TEMPLATE', 'BASE', 'OPTION', 'OPTGROUP']);
const MEDIA = new Set(['IMG', 'VIDEO', 'CANVAS', 'SVG', 'PICTURE', 'IFRAME', 'OBJECT', 'EMBED']);
const nodes = body ? [root, body, ...body.querySelectorAll('*')].slice(0, MAX_ELEMENTS + 2) : [root];
const states = new Map();
const painters = [];
const boxes = new Map();
const rects = new Map();
let elements = 0;
const rectOf = (el) => {
    let rect = rects.get(el);

    if (!rect) {
        rect = el.getBoundingClientRect();
        rects.set(el, rect);
    }

    return rect;
};
const intersects = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

for (const el of nodes) {
    if (SKIP.has(el.tagName.toUpperCase()) || el.namespaceURI !== XHTML) {
        if (el.localName === 'svg' && el.namespaceURI !== XHTML) {
            const style = getComputedStyle(el);

            if (style.display !== 'none' && painters.length < 300) {
                const rect = rectOf(el);

                if (rect.width > 0 && rect.height > 0) painters.push({ el, rect });
            }
        }

        continue;
    }

    const style = getComputedStyle(el);

    if (style.display === 'none') continue;

    const parent = el.parentElement;
    const before = parent ? states.get(parent) : undefined;
    let back = before ? before.back : canvasRgb;
    let cum = before ? before.cum : 1;
    let uncertain = before ? before.uncertain : false;
    let clip = before ? before.clip : false;
    let fixed = before ? before.fixed : false;
    const opacity = parseFloat(style.opacity);

    cum *= Number.isNaN(opacity) ? 1 : opacity;
    const bg = toRgba(style.backgroundColor) || [0, 0, 0, 0];

    if (bg[3] > 0) back = mix(back, bg, bg[3] * cum);

    const image = style.backgroundImage !== 'none';

    if (image || style.filter !== 'none' || (style.backdropFilter || 'none') !== 'none' || style.mixBlendMode !== 'normal') uncertain = true;

    // Partial opacity (a faded state, a transition caught half way) and an overlay drawn by ::before or ::after make
    // what is behind the text uncertain; so does a clip or a mask.
    if (cum < 0.99 || (style.clipPath !== 'none' && style.clipPath !== undefined) || (style.maskImage || style.webkitMaskImage || 'none') !== 'none') uncertain = true;

    for (const pseudo of ['::before', '::after']) {
        const made = getComputedStyle(el, pseudo);

        if (made.content !== 'none' && made.content !== 'normal' && made.display !== 'none' && (made.position === 'absolute' || made.position === 'fixed') && (made.backgroundImage !== 'none' || (toRgba(made.backgroundColor) || [0, 0, 0, 0])[3] > 0)) uncertain = true;
    }

    if (el !== root && el !== body && style.overflowX !== 'visible') clip = true;

    if (style.position === 'fixed') fixed = true;

    states.set(el, { back, cum, uncertain, clip, fixed, before: before ? before.back : canvasRgb });

    if (painters.length < 300 && el !== root && el !== body) {
        const rect = rectOf(el);

        if (rect.width > 0 && rect.height > 0) {
            const positioned = style.position === 'absolute' || style.position === 'fixed' || style.zIndex !== 'auto' || style.transform !== 'none';

            if (MEDIA.has(el.tagName) || image || (positioned && bg[3] > 0)) painters.push({ el, rect });
        }
    }
}

const overlapped = (el, rect) => painters.some((item) => item.el !== el && !item.el.contains(el) && !el.contains(item.el) && intersects(rect, item.rect));
const hasText = (el) => {
    for (const child of el.childNodes) {
        if (child.nodeType === 3 && child.nodeValue.trim() !== '') return true;
    }

    return el.localName === 'input' && /^(button|submit|reset)$/.test(el.type) && el.value !== '';
};
const familyOf = (list) => {
    const first = list.split(',')[0].trim().replace(/^["']|["']$/g, '');

    return first.toLowerCase();
};
const pxOf = (value) => parseFloat(value);
const pointed = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=switch]';
const interactive = pointed + ',[tabindex]:not([tabindex="-1"])';
const OS_BLACK = 'rgba(0, 0, 0, 1)';
const targets = [];
const textFamilies = new Map();
const focusCandidates = new Map();
const viewWidth = root.clientWidth || win.innerWidth;
const offenders = [];
const fontInfo = new Map();
const spaceSeen = new Map();
const radiusSeen = new Map();
const scaleSides = [['top', 'Top'], ['right', 'Right'], ['bottom', 'Bottom'], ['left', 'Left']];
`;
