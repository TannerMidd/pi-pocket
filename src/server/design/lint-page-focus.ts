// Plain JavaScript in a string: one part of the page script of `lint-page.ts`. The parts form one function body, so they share its locals.
export const PAGE_FOCUS = String.raw`// Icons that are the whole of a control (a button with only an SVG): their strokes and fills need 3:1 (WCAG 1.4.11)
// against what is behind them, judged only when every color that the icon paints fails.
for (const control of [...doc.querySelectorAll(pointed)].slice(0, 300)) {
    const icon = control.querySelector('svg');

    if (!icon || (control.textContent || '').trim() !== '' || control.localName === 'input' || control.matches(':disabled')) continue;

    const box = control.getBoundingClientRect();
    let node = icon.parentElement;

    while (node && !states.get(node)) node = node.parentElement;

    const state = node ? states.get(node) : null;

    if (!state || state.uncertain || box.width <= 0 || box.height <= 0 || getComputedStyle(control).visibility !== 'visible') continue;

    const painted = [];
    let unknown = false;

    for (const shape of [...icon.querySelectorAll('path,circle,rect,line,polyline,polygon,ellipse')].slice(0, 60)) {
        const look = getComputedStyle(shape);

        if (look.display === 'none' || look.visibility !== 'visible') continue;

        // The default fill of a shape is black: it counts only when the icon says so (an attribute or a style), as a line
        // drawn with a stroke has no area to fill.
        let said = false;

        for (let each = shape; each && each !== icon.parentElement; each = each.parentElement) {
            if (each.hasAttribute('fill') || (each.style && each.style.fill)) said = true;
        }

        for (const [paint, on] of [[look.fill, look.fill !== 'none' && (said || look.fill !== 'rgb(0, 0, 0)')], [look.stroke, look.stroke !== 'none' && pxOf(look.strokeWidth) > 0]]) {
            if (!on) continue;

            const rgba = toRgba(paint);

            if (!rgba) unknown = true;
            else if (rgba[3] * state.cum > 0.05) painted.push(rgba);
        }
    }

    if (unknown || painted.length === 0) continue;

    const ratios = painted.map((rgba) => contrastOf(mix(state.back, rgba, rgba[3]), state.back));

    if (Math.max(...ratios) < 3) {
        const best = painted[ratios.indexOf(Math.max(...ratios))];
        const fg = mix(state.back, best, best[3]).map(Math.round);
        const bg = state.back.map(Math.round);

        group(groups.contrast, 'icon|' + fg + '|' + bg, () => ({ fg, bg, size: 0, large: false, ui: true, ratio: Math.max(...ratios), what: 'icon', tag: control.localName, edges: [] }), control);
    }
}

const focusProps = ['outlineStyle', 'outlineWidth', 'outlineColor', 'boxShadow', 'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor', 'borderTopWidth', 'backgroundColor', 'color', 'textDecorationLine', 'textDecorationColor', 'filter', 'opacity', 'transform', 'backgroundImage'];
const snapshot = (list) => list.map((node) => { const s = getComputedStyle(node); return focusProps.map((p) => s[p]).join('|'); }).join('||');
const focusResults = [];
const startActive = doc.activeElement;

for (const { el, count } of [...focusCandidates.values()].slice(0, 40)) {
    if (focusResults.length >= 20) break;

    const scope = new Set([el, ...[...el.querySelectorAll('*')].slice(0, 12), ...(el.labels ? [...el.labels] : [])]);
    let ancestor = el.parentElement;

    for (let depth = 0; ancestor && depth < 3; depth++) {
        scope.add(ancestor);
        [...ancestor.children].slice(0, 12).forEach((child) => scope.add(child));
        ancestor = ancestor.parentElement;
    }

    const list = [...scope];
    const before = snapshot(list);
    const rest = getComputedStyle(el);
    const restOutline = [rest.outlineStyle, rest.outlineWidth, rest.outlineColor].join('|');
    const restShadow = rest.boxShadow;
    const restRing = restOutline + '|' + restShadow;

    try {
        el.focus({ preventScroll: true, focusVisible: true });
    } catch {
        continue;
    }

    if (doc.activeElement !== el) continue;

    const after = snapshot(list);
    const style = getComputedStyle(el);
    const ring = !/^(none|hidden)$/.test(style.outlineStyle) && pxOf(style.outlineWidth) !== 0 && (toRgba(style.outlineColor) || [0, 0, 0, 0])[3] > 0;

    // The ring that the focus draws (an outline or a spread-only shadow that was not there at rest), and how it reads
    // against what is around it: 3:1 (WCAG 1.4.11). The browser's own auto ring is two-toned and is left alone.
    const drawn = [style.outlineStyle, style.outlineWidth, style.outlineColor, style.boxShadow].join('|');
    const state = states.get(el);

    if (state && !state.uncertain && drawn !== restRing && style.outlineStyle !== 'auto') {
        const rings = [];

        if (ring && restOutline !== [style.outlineStyle, style.outlineWidth, style.outlineColor].join('|')) {
            const color = toRgba(style.outlineColor);

            rings.push({ color, back: pxOf(style.outlineOffset) < 0 ? state.back : state.before });
        }

        for (const layer of style.boxShadow === restShadow ? [] : style.boxShadow.split(/,(?![^(]*\))/)) {
            const m = /^\s*(rgba?\([^)]*\)|color\([^)]*\)|#[0-9a-f]+)\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+([\d.]+)px\s+([\d.]+)px\s*$/i.exec(layer);

            if (m && parseFloat(m[2]) === 0 && parseFloat(m[3]) === 0 && parseFloat(m[4]) === 0 && parseFloat(m[5]) >= 1) rings.push({ color: toRgba(m[1]), back: state.before });
        }

        const ratios = rings.filter((item) => item.color && item.color[3] > 0).map((item) => ({ ratio: contrastOf(mix(item.back, item.color, item.color[3]), item.back), item }));

        // Every ring that it draws must fail: a double ring (a light gap, then a dark ring) passes by its best.
        if (ratios.length > 0 && Math.max(...ratios.map((r) => r.ratio)) < 3) {
            const worst = ratios.sort((a, b) => b.ratio - a.ratio)[0];
            const fg = mix(worst.item.back, worst.item.color, worst.item.color[3]).map(Math.round);
            const bg = worst.item.back.map(Math.round);

            group(groups.contrast, 'ring|' + fg + '|' + bg, () => ({ fg, bg, size: 0, large: false, ui: true, ratio: worst.ratio, what: 'focus', tag: el.localName, edges: [] }), el);
        }
    }

    el.blur();

    if (!ring && before === after) {
        focusResults.push({ count, tag: el.localName, outlineNone: style.outlineStyle === 'none' || pxOf(style.outlineWidth) === 0, el: infoOf(el) });
    }
}

if (startActive && startActive !== doc.body) startActive.focus({ preventScroll: true });

calm.remove();
probeHost.remove();

return {
    elements,
    viewport: { width: win.innerWidth, height: win.innerHeight },
    hasViewportMeta: doc.querySelector('meta[name=viewport]') !== null,
    resolvedColors,
    resolvedLengths,
    colors: finish(groups.colors),
    fonts: finish(groups.fonts),
    sizes: finish(groups.sizes),
    contrast: finish(groups.contrast),
    targets: finish(groups.targets),
    overflow,
    images: finish(groups.images),
    headings: headingResults,
    fontFaces,
    focus: focusResults,
    pids: finish(groups.pids),
    notJudged: { count: notJudged.count, elements: notJudged.els.map(selectorOf) },
    semantics,
    labels: finish(groups.labels),
    names: finish(groups.names),
    zoom: finish(groups.zoom),
    motion: { count: motion.count, longest: motion.longest, override: motion.override, unreadable: motion.unreadable, el: motion.first ? infoOf(motion.first) : undefined },
};
})`;
