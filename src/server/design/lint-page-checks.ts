// Plain JavaScript in a string: one part of the page script of `lint-page.ts`. The parts form one function body, so they share its locals.
export const PAGE_CHECKS = String.raw`
const shown = (el) => {
    const look = getComputedStyle(el);
    const box = el.getBoundingClientRect();

    return look.display !== 'none' && look.visibility === 'visible' && box.width > 0 && box.height > 0 && el.getAttribute('aria-hidden') !== 'true' && !el.closest('[hidden],[inert]');
};
const textOfIds = (ids) => ids.split(/\s+/).map((id) => { const node = doc.getElementById(id); return node ? (node.textContent || '').trim() : ''; }).join('').trim();
const named = (el) => (el.getAttribute('aria-label') || '').trim() !== '' || (el.getAttribute('aria-labelledby') && textOfIds(el.getAttribute('aria-labelledby')) !== '') || (el.getAttribute('title') || '').trim() !== '';

// A field needs a label, an aria-label, an aria-labelledby, or a title. A placeholder is not a name: it goes away when a
// person types and not every screen reader reads it (WCAG 1.3.1, 3.3.2).
const fieldKind = (el) => (el.localName === 'input' ? 'input type=' + (el.getAttribute('type') || 'text') : el.localName) + (el.getAttribute('role') && !/^(input|select|textarea)$/.test(el.localName) ? '[role=' + el.getAttribute('role') + ']' : '');

for (const el of [...doc.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]),select,textarea')].slice(0, 300)) {
    if (!shown(el)) continue;

    const labelled = [...(el.labels || [])].some((label) => (label.textContent || '').trim() !== '');

    if (labelled || named(el)) continue;

    group(groups.labels, fieldKind(el), () => ({ kind: fieldKind(el) }), el);
}

// ARIA widgets that stand in for a field: a text box, a search box, a combo box, a slider need a name of their own (their
// content is their value, not their name); a checkbox or a radio may be named by its content.
for (const el of [...doc.querySelectorAll('[role=textbox],[role=searchbox],[role=combobox],[role=slider],[role=spinbutton],[role=checkbox],[role=radio]')].slice(0, 300)) {
    if (/^(input|select|textarea)$/.test(el.localName) || !shown(el) || named(el)) continue;

    const role = el.getAttribute('role');

    if (/^(checkbox|radio)$/.test(role) && (el.textContent || '').trim() !== '') continue;

    group(groups.labels, fieldKind(el), () => ({ kind: fieldKind(el) }), el);
}

for (const el of [...doc.querySelectorAll('a[href],button,summary,[role=button],[role=link],[role=switch],[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=option]')].slice(0, 400)) {
    if (/^(input|select|textarea)$/.test(el.localName)) continue;

    if (!shown(el) || named(el) || (el.textContent || '').trim() !== '' || [...(el.labels || [])].some((label) => (label.textContent || '').trim() !== '')) continue;

    const image = [...el.querySelectorAll('img')].some((img) => (img.getAttribute('alt') || '').trim() !== '');
    const svg = [...el.querySelectorAll('svg title')].some((title) => (title.textContent || '').trim() !== '') || [...el.querySelectorAll('svg,[role=img]')].some((node) => named(node));

    if (image || svg) continue;

    const kind = el.localName + (el.getAttribute('role') ? '[role=' + el.getAttribute('role') + ']' : '');

    group(groups.names, kind, () => ({ kind }), el);
}

// A text field under 16 px makes iOS zoom the page when it gets the focus. Only a size that the author set is judged: the
// browser's own control size is not the size that iOS goes by.
for (const el of [...doc.querySelectorAll('input,textarea,select')].slice(0, 300)) {
    if (el.localName === 'input' && !/^(text|email|password|search|tel|url|number|)$/.test(el.getAttribute('type') || '')) continue;

    if (!shown(el) || !inheritedAuthored(el, 'fontSize')) continue;

    const px = pxOf(getComputedStyle(el).fontSize);

    if (px < 16) group(groups.zoom, 'zoom|' + round(px), () => ({ px: round(px), kind: el.localName === 'input' ? 'input type=' + (el.getAttribute('type') || 'text') : el.localName }), el);
}

const semantics = {
    lang: (root.getAttribute('lang') || '').trim() !== '',
    main: doc.querySelector('main,[role=main]') !== null,
    html: infoOf(root),
    body: infoOf(body),
};

for (const el of [...doc.querySelectorAll('img,input[type=image],[role=img]')].slice(0, 500)) {
    const tag = el.localName;
    const role = el.getAttribute('role');
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const hidden = el.getAttribute('aria-hidden') === 'true' || role === 'presentation' || role === 'none' || style.display === 'none' || style.visibility !== 'visible' || rect.width <= 0 || rect.height <= 0;

    if (hidden) continue;

    const named = el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') || (tag !== 'img' && tag !== 'input' && (el.hasAttribute('title') || el.querySelector('title')));
    let why = '';

    if ((tag === 'img' || tag === 'input') && !el.hasAttribute('alt') && !named) why = 'no alt attribute';
    else if (tag !== 'img' && tag !== 'input' && !named) why = 'role=img with no accessible name';

    if (why) group(groups.images, tag + '|' + (el.getAttribute('src') || '').slice(0, 120) + '|' + why, () => ({ tag, why }), el);
}

// Elements that can take the focus, one for each kind. A control that is see-through (a custom checkbox) still counts.
for (const el of [...doc.querySelectorAll(interactive)].slice(0, 1000)) {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();

    if (style.display === 'none' || style.visibility !== 'visible' || rect.width <= 0 || rect.height <= 0 || el.matches(':disabled') || el.getAttribute('aria-hidden') === 'true') continue;

    if (el.parentElement && el.parentElement.closest(interactive)) continue;

    if (el.closest('[inert]') || (input.deck && !el.closest('section.slide'))) continue;

    // A specimen of the focus state (class is-focus, a static ring) is not the real thing: it has the ring at rest.
    if ([...el.classList].some((name) => /(^|[-_])(focus|focused|focus-visible)($|[-_])/i.test(name)) || el.hasAttribute('data-focus')) continue;

    const key = el.localName + '.' + [...el.classList].slice(0, 3).join('.');

    if (!focusCandidates.has(key)) focusCandidates.set(key, { el, count: 0 });

    focusCandidates.get(key).count++;
}

// Tap targets: under 24 px is an error, under 44 px a warning (WCAG 2.2 sets 24 px; 44 px is the common touch advice).

for (const target of targets) {
    // Whole pixels: a 43.99 px box from fractional text widths is 44.
    const least = Math.round(Math.min(target.width, target.height));
    const level = least < 24 ? 'error' : least < 44 ? 'warning' : '';

    if (level) {
        const width = Math.round(target.width);
        const height = Math.round(target.height);

        group(groups.targets, level + '|' + width + 'x' + height + '|' + target.tag, () => ({ level, width, height, tag: target.tag }), target.el);
    }
}


let overflow;

if (!input.deck) {
    const scrollWidth = Math.max(root.scrollWidth, body ? body.scrollWidth : 0);
    const viewportX = rootStyle.overflowX === 'visible' && body ? getComputedStyle(body).overflowX : rootStyle.overflowX;
    const clipped = /^(hidden|clip)$/.test(viewportX);

    // Hidden overflow of decoration (a glow, a blob) is on purpose; hidden text, controls, and images are not.
    const cut = offenders.filter((item) => item.content);

    // Page scrolls: every offender. Page clips: only those with something to read or touch.
    const shown = clipped ? cut : offenders;

    if ((scrollWidth > viewWidth + 1 && !clipped) || (clipped && cut.length > 0)) {
        shown.sort((a, b) => b.right - a.right);
        overflow = { scrollWidth: Math.round(scrollWidth), clientWidth: Math.round(viewWidth), clipped, offenders: shown.length, el: shown[0] ? infoOf(shown[0].el) : undefined };
    }
}

const headingResults = [];
let previousLevel = 0;

for (const { el, level } of headings) {
    if (previousLevel > 0 && level > previousLevel + 1 && headingResults.length < 10) {
        headingResults.push({ count: 1, level, previous: previousLevel, el: infoOf(el) });
    }

    previousLevel = level;
}

const faces = [];

if (doc.fonts && doc.fonts.forEach) {
    doc.fonts.forEach((face) => faces.push({ family: String(face.family).replace(/^["']|["']$/g, '').toLowerCase(), status: face.status }));
}

const KEYWORD = /^(-apple-system|blinkmacsystemfont|system-ui|ui-[a-z-]+|serif|sans-serif|monospace|cursive|fantasy|emoji|math|fangsong|inherit|initial|unset)$/;
const OS_FONTS = new Set(['arial', 'helvetica', 'helvetica neue', 'times new roman', 'times', 'courier new', 'courier', 'georgia', 'verdana', 'tahoma', 'trebuchet ms', 'segoe ui', 'menlo', 'monaco', 'consolas', 'sf pro', 'sf pro text', 'sf pro display', 'sf mono', 'san francisco', 'lucida grande', 'impact', 'palatino', 'garamond', 'comic sans ms', 'apple color emoji', 'segoe ui emoji', 'noto color emoji', 'roboto', 'ubuntu', 'cantarell', 'noto sans', 'liberation sans', 'dejavu sans']);
const meter = doc.createElement('span');
meter.textContent = 'mmmmmmmmmmlliWW@@';
meter.style.cssText = 'position:absolute;visibility:hidden;left:-9999px;top:0;white-space:nowrap;font-size:72px;font-style:normal;font-weight:400;letter-spacing:0';
body.append(meter);
const widthOf = (family) => {
    meter.style.fontFamily = family;

    return meter.getBoundingClientRect().width;
};
const bases = ['monospace', 'serif', 'sans-serif'].map((name) => [name, widthOf(name)]);
const installed = (family) => bases.some(([name, width]) => widthOf('"' + family.replace(/"/g, '') + '",' + name) !== width);
const fontFaces = [];
const shownName = (list) => list.split(',')[0].trim().replace(/^["']|["']$/g, '');

for (const [family, el] of textFamilies) {
    if (KEYWORD.test(family) || fontFaces.length >= 12) continue;

    const own = faces.filter((face) => face.family === family);
    const count = fontInfo.get(family).count;

    if (own.length > 0 && !own.some((face) => face.status === 'loaded')) {
        fontFaces.push({ count, family: shownName(fontInfo.get(family).list), why: 'the @font-face did not load (' + own[0].status + ')', failed: true, el: infoOf(el) });
    } else if (own.length === 0 && !OS_FONTS.has(family) && !installed(family)) {
        fontFaces.push({ count, family: shownName(fontInfo.get(family).list), why: 'there is no @font-face for it and it is not installed', failed: false, el: infoOf(el) });
    }
}

meter.remove();
`;
