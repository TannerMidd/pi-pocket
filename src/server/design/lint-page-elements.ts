// Plain JavaScript in a string: one part of the page script of `lint-page.ts`. The parts form one function body, so they share its locals.
export const PAGE_ELEMENTS = String.raw`for (const el of nodes) {
    const state = states.get(el);

    if (!state) continue;

    const style = getComputedStyle(el);
    const rect = rectOf(el);
    const box = rect.width > 0 && rect.height > 0 && style.display !== 'contents';

    if (!box && el !== root && el !== body) continue;
    if (style.visibility !== 'visible' || state.cum < 0.01) continue;
    if (rect.right + win.scrollX < 0 || rect.bottom + win.scrollY < 0) continue;

    elements++;
    const tag = el.localName;
    const text = hasText(el);
    const disabled = el.matches(':disabled');
    const parentStyle = el.parentElement ? getComputedStyle(el.parentElement) : null;

    const used = new Set();
    const useColor = (css, role) => {
        const rgba = toRgba(css);

        if (!rgba || rgba[3] <= 0) return;

        const key = rgba.map((n) => round(n)).join(',');
        const hard = input.literals === true && authoredColor(el, role, rgba);

        if (used.has(role + key)) return;

        used.add(role + key);
        const found = group(groups.colors, key + '|' + role + (hard ? '|L' : ''), () => ({ rgba, roles: {}, literal: hard }), el);

        if (found) found.roles[role] = (found.roles[role] || 0) + 1;
    };

    const fill = toRgba(style.webkitTextFillColor || style.color);
    const gradientText = style.backgroundClip === 'text' || style.webkitBackgroundClip === 'text' || (fill && fill[3] === 0);

    if (text && !gradientText && inheritedAuthored(el, 'color')) {
        useColor(style.webkitTextFillColor || style.color, 'text');
    }

    if (authoredOwn(el, 'backgroundColor', style)) useColor(style.backgroundColor, 'background');

    for (const [side, name] of scaleSides) {
        // A border drawn in the text color (currentcolor) is the text color's to judge.
        if (pxOf(style['border' + name + 'Width']) > 0 && !/^(none|hidden)$/.test(style['border' + name + 'Style']) && style['border' + name + 'Color'] !== style.color && authoredOwn(el, 'border' + name + 'Color', style)) {
            useColor(style['border' + name + 'Color'], 'border');
        }
    }

    if (pxOf(style.outlineWidth) > 0 && !/^(none|hidden)$/.test(style.outlineStyle) && authoredOwn(el, 'outlineColor', style)) useColor(style.outlineColor, 'outline');

    // Text made invisible on purpose (a screen-reader-only label) is not judged.
    const hiddenText = /^rect\(0(px)?,? ?0(px)?,? ?0(px)?,? ?0(px)?\)$/.test(style.clip) || /^inset\((50|100)%/.test(style.clipPath) || pxOf(style.textIndent) <= -500 || (/^(hidden|clip)$/.test(style.overflowX) && rect.height <= 1);

    if (text && !gradientText && !hiddenText && fill && rect.width > 1 && rect.height > 1 && pxOf(style.fontSize) >= 1) {
        const fontSize = pxOf(style.fontSize);
        const family = familyOf(style.fontFamily);

        // The font and the size that the author set; the browser's own (a heading's size, the default serif) are not judged.
        if (inheritedAuthored(el, 'fontFamily')) {
            const hardFamily = input.literals === true && authoredFamily(el, family);

            group(groups.fonts, family + (hardFamily ? '|L' : ''), () => ({ family, list: style.fontFamily.slice(0, 300), literal: hardFamily }), el);

            const info = fontInfo.get(family) || { list: style.fontFamily.slice(0, 300), count: 0 };

            info.count++;
            fontInfo.set(family, info);

            if (!textFamilies.has(family)) textFamilies.set(family, el);
        }

        if (inheritedAuthored(el, 'fontSize')) {
            const hardSize = input.literals === true && authoredLength(el, 'font-size', fontSize, style);

            group(groups.sizes, 'font-size|' + round(fontSize) + (hardSize ? '|L' : ''), () => ({ kind: 'font-size', px: round(fontSize), props: ['font-size'], literal: hardSize }), el);
        }

        const near = overlapped(el, rect);

        if (!state.uncertain && !near && !disabled) {
            const alpha = fill[3] * state.cum;
            const fg = mix(state.back, fill, alpha).map(Math.round);
            const bgc = state.back.map(Math.round);
            const weight = parseInt(style.fontWeight, 10) || 400;
            const large = fontSize >= 24 || (fontSize >= 18.66 && weight >= 700);

            group(groups.contrast, 'text|' + fg + '|' + bgc + '|' + large, () => ({ fg, bg: bgc, size: round(fontSize), large, ui: false }), el);
        } else if (!disabled) {
            notJudged.count++;

            if (notJudged.els.length < 8) notJudged.els.push(el);
        }
    }

    if (!disabled && (tag === 'select' || tag === 'textarea' || (tag === 'input' && !/^(hidden|checkbox|radio|range|color|file|button|submit|reset|image)$/.test(el.type))) && !state.uncertain) {
        const around = state.before;
        const own = state.back;
        let best = 0;
        const ratioOf = (a, b) => {
            const lum = (c) => c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
            const [la, lb] = [lum(a), lum(b)].map((c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]);

            return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
        };
        let edge = false;
        const edges = [];
        const fillRaw = toRgba(style.backgroundColor);

        best = ratioOf(own, around);

        if (best > 1.02) {
            edge = true;

            if (fillRaw && fillRaw[3] > 0) edges.push(fillRaw);
        }

        for (const [side, name] of scaleSides) {
            const color = toRgba(style['border' + name + 'Color']);

            if (pxOf(style['border' + name + 'Width']) > 0 && !/^(none|hidden)$/.test(style['border' + name + 'Style']) && color && color[3] > 0) {
                edge = true;
                edges.push(color);
                best = Math.max(best, ratioOf(mix(own, color, color[3] * state.cum), around));
            }
        }

        if (edge && best < 3) {
            group(groups.contrast, 'ui|' + own.map(Math.round) + '|' + around.map(Math.round) + '|' + best.toFixed(1), () => ({ fg: own.map(Math.round), bg: around.map(Math.round), size: 0, large: false, ui: true, ratio: best, edges: edges.slice(0, 5) }), el);
        }
    }

    if (box) {
        const space = (value, prop, auto, uaProp) => {
            const px = Math.abs(pxOf(value));

            if (auto || !(px > 0.5) || Number.isNaN(px) || !authoredOwn(el, uaProp, style)) return;

            const hard = input.literals === true && authoredLength(el, 'space', px, style);
            const key = 'space|' + round(px) + (hard ? '|L' : '');

            let seen = spaceSeen.get(key);

            if (!seen || seen.el !== el) {
                seen = { el, found: group(groups.sizes, key, () => ({ kind: 'space', px: round(px), props: [], literal: hard }), el) };
                spaceSeen.set(key, seen);
            }

            const found = seen.found;

            if (found && found.props.length < 3 && !found.props.includes(prop)) found.props.push(prop);
        };
        let map = null;

        try {
            map = el.computedStyleMap();
        } catch {
            map = null;
        }

        const typed = (prop) => {
            const value = map ? map.get(prop) : null;

            if (!value) return false;

            return value.toString() === 'auto' || (value.unit === 'percent');
        };

        // A native checkbox or radio keeps the browser's margin unless the page changes it.
        const native = tag === 'input' && /^(checkbox|radio)$/.test(el.type);

        for (const [side, name] of scaleSides) {
            space(style['padding' + name], 'padding', typed('padding-' + side), 'padding' + name);
            space(style['margin' + name], 'margin', native || typed('margin-' + side), 'margin' + name);
        }

        space(style.rowGap === 'normal' ? '0px' : style.rowGap, 'gap', false, 'rowGap');
        space(style.columnGap === 'normal' ? '0px' : style.columnGap, 'gap', false, 'columnGap');

        for (const corner of ['TopLeft', 'TopRight', 'BottomRight', 'BottomLeft']) {
            const value = style['border' + corner + 'Radius'];

            if (value.includes('%')) continue;

            const px = pxOf(value);

            if (!(px > 0.5) || px >= Math.min(rect.width, rect.height) / 2 || !authoredOwn(el, 'border' + corner + 'Radius', style)) continue;

            const hard = input.literals === true && authoredLength(el, 'radius', px, style);
            const key = 'radius|' + round(px) + (hard ? '|L' : '');

            if (radiusSeen.get(key) === el) continue;

            radiusSeen.set(key, el);
            group(groups.sizes, key, () => ({ kind: 'radius', px: round(px), props: ['border-radius'], literal: hard }), el);
        }
    }

    if (!input.deck && el.matches(pointed) && !disabled && el.getAttribute('aria-hidden') !== 'true' && !el.parentElement.closest(pointed)) {
        let width = rect.width;
        let height = rect.height;
        let left = rect.left;
        let top = rect.top;
        const labels = el.labels ? [...el.labels] : [];
        const isCheck = tag === 'input' && /^(checkbox|radio)$/.test(el.type);

        for (const label of labels) {
            const lr = label.getBoundingClientRect();

            if (lr.width * lr.height > width * height) {
                width = lr.width;
                height = lr.height;
                left = lr.left;
                top = lr.top;
            }
        }

        const inline = style.display === 'inline' && tag !== 'input' && tag !== 'button' && tag !== 'select' && tag !== 'textarea' && el.parentElement && [...el.parentElement.childNodes].some((n) => n !== el && n.nodeType === 3 && n.nodeValue.trim() !== '');
        const bare = (isCheck || (tag === 'input' && el.type === 'range')) && style.appearance !== 'none' && labels.length === 0;

        // A control that the page has not styled at all (no padding, border, or font size of its own) is the browser's: its size is not the page's.
        const unstyled = /^(button|input|select|textarea|summary)$/.test(tag) && !authoredOwn(el, 'paddingTop', style) && !authoredOwn(el, 'borderTopWidth', style) && !authoredOwn(el, 'paddingLeft', style) && !inheritedAuthored(el, 'fontSize');

        if (!inline && !bare && !unstyled && width > 0 && height > 0) targets.push({ el, left, top, width, height, tag });
    }

    if (!input.deck && el !== root && el !== body && !state.clip && !state.fixed && rect.right > viewWidth + 1) offenders.push({ el, right: rect.right, content: (el.textContent || '').trim() !== '' || el.matches(pointed + ',img,video,canvas,svg') });

    const level = /^h[1-6]$/.test(tag) ? Number(tag[1]) : el.getAttribute('role') === 'heading' ? Number(el.getAttribute('aria-level')) : 0;

    if (level >= 1 && level <= 6 && (el.textContent || '').trim() !== '') headings.push({ el, level });

    if (/^(header|nav|main|footer|section|article|aside|form|h[1-6]|button|img|a|input|select|textarea)$/.test(tag) && !el.hasAttribute('data-pid') && !(tag === 'a' && !el.hasAttribute('href'))) {
        group(groups.pids, tag, () => ({ tag }), el);
    }
}
`;
