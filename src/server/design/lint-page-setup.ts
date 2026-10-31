// Plain JavaScript in a string: one part of the page script of `lint-page.ts`. The parts form one function body, so they share its locals.
export const PAGE_SETUP = String.raw`(async (input) => {
const doc = document;
const win = window;
const root = doc.documentElement;
const body = doc.body;
const XHTML = 'http://www.w3.org/1999/xhtml';
const MAX_ELEMENTS = 4000;
const MAX_GROUPS = 300;
const round = (n) => Math.round(n * 100) / 100;

// The page's style sheets, as rules. A sheet linked from the bundle comes from the render's own server, and the sandbox
// makes that another origin, so the browser will not show its rules: read its text and parse it here instead. A sheet
// that cannot be read at all (another site's) makes "what the page's CSS says" unknown, and the checks that need it
// say less rather than guess.
const sheetRules = [];
let sheetsUnreadable = false;

for (const sheet of doc.styleSheets) {
    if (sheet.disabled || (sheet.media && sheet.media.length > 0 && !win.matchMedia(sheet.media.mediaText).matches)) continue;

    try {
        sheetRules.push(sheet.cssRules);
    } catch {
        try {
            if (!sheet.href) throw new Error('no address');

            const response = await fetch(sheet.href);
            const text = await response.text();

            if (!response.ok || text.length > 2000000) throw new Error('unusable');

            const parsed = new CSSStyleSheet();

            parsed.replaceSync(text);
            sheetRules.push(parsed.cssRules);
        } catch {
            sheetsUnreadable = true;
        }
    }
}

// Motion first: the calm style below would hide it.
const MOTION_MS = 500;
const motion = { count: 0, longest: 0, first: null, override: false, unreadable: false };
const toMs = (text) => text.split(',').map((part) => { const t = part.trim(); return t.endsWith('ms') ? parseFloat(t) : t.endsWith('s') ? parseFloat(t) * 1000 : 0; });

for (const el of [...(body ? body.querySelectorAll('*') : [])].slice(0, 3000)) {
    const style = getComputedStyle(el);

    if (style.display === 'none') continue;

    const props = style.transitionProperty.split(',').map((part) => part.trim());
    const transition = Math.max(0, ...toMs(style.transitionDuration).filter((ms, at) => props[at % props.length] !== 'none'));
    const names = style.animationName.split(',').map((part) => part.trim());
    const durations = toMs(style.animationDuration);
    const repeats = style.animationIterationCount.split(',').map((part) => part.trim());
    let animation = 0;

    names.forEach((name, at) => {
        const ms = durations[at % durations.length];

        if (name === 'none' || !(ms > 0)) return;

        animation = Math.max(animation, repeats[at % repeats.length] === 'infinite' ? Math.max(ms, MOTION_MS + 1) : ms);
    });

    const longest = Math.max(transition, animation);

    if (longest > MOTION_MS) {
        motion.count++;
        motion.longest = Math.max(motion.longest, Math.round(longest));
        if (!motion.first) motion.first = el;
    }
}

const reducedRule = (rules) => {
    for (const rule of rules) {
        if (rule.media && /prefers-reduced-motion/.test(rule.media.mediaText || '')) return true;
        if (rule.conditionText && /prefers-reduced-motion/.test(rule.conditionText)) return true;
        if (rule.cssRules && reducedRule(rule.cssRules)) return true;
    }

    return false;
};

for (const rules of sheetRules) {
    if (reducedRule(rules)) motion.override = true;
}

motion.unreadable = sheetsUnreadable;

const calm = doc.createElement('style');
calm.textContent = '*,*::before,*::after{transition:none!important;animation:none!important}';
doc.head.append(calm);
`;
