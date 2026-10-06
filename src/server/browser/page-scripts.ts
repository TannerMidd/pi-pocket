/**
 * The scripts the built-in browser runs inside a page. They run there as written, so they are plain JavaScript in
 * strings.
 */
/**
 * The page outline Pi reads: headings, text, and every control with a ref (`[e12]`) that click, type, select, and
 * hover take until the next snapshot. Refs are kept in the page itself, as weak references, so a page that changed
 * underneath still finds the controls it has. Elements that only look clickable (a `cursor: pointer` div with a
 * script's listener) count as controls too: apps are full of them.
 */
export const SNAPSHOT_SCRIPT = String.raw`(() => {
	const MAX = 16000;
	const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "LINK", "BR", "WBR"]);
	const ROLES = new Set(["button", "link", "checkbox", "radio", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "switch", "option", "combobox", "textbox", "searchbox", "slider", "spinbutton", "treeitem", "listbox"]);
	const INPUTS = { button: "button", submit: "button", reset: "button", image: "button", file: "button", color: "button", checkbox: "checkbox", radio: "radio", range: "slider", number: "spinbutton", search: "searchbox" };
	const LANDMARKS = { HEADER: "header", NAV: "nav", MAIN: "main", ASIDE: "aside", FOOTER: "footer", FORM: "form", DIALOG: "dialog", TABLE: "table" };
	const styles = new Map();
	const style = (el) => { let s = styles.get(el); if (!s) { s = getComputedStyle(el); styles.set(el, s); } return s; };
	const clip = (text, max) => { const flat = String(text ?? "").replace(/\s+/g, " ").trim(); return flat.length > max ? flat.slice(0, max - 1) + "…" : flat; };
	const shown = (el) => { const s = style(el); if (s.display === "contents") return true; return s.display !== "none" && s.visibility !== "hidden" && s.visibility !== "collapse" && el.getClientRects().length > 0; };
	const up = (el) => el.parentElement ?? (el.parentNode instanceof ShadowRoot ? el.parentNode.host : null);
	const roleOf = (el) => {
		const explicit = el.getAttribute("role");
		if (explicit) return explicit.trim().split(/\s+/)[0];
		const tag = el.tagName;
		if (tag === "A") return el.hasAttribute("href") ? "link" : null;
		if (tag === "BUTTON" || tag === "SUMMARY") return "button";
		if (tag === "SELECT") return el.multiple ? "listbox" : "combobox";
		if (tag === "TEXTAREA") return "textbox";
		if (tag === "INPUT") { const type = (el.getAttribute("type") || "text").toLowerCase(); return type === "hidden" ? null : (INPUTS[type] ?? "textbox"); }
		if (el.isContentEditable && (el.getAttribute("contenteditable") ?? "") !== "false" && !el.parentElement?.isContentEditable) return "textbox";
		if (/^H[1-6]$/.test(tag)) return "heading";
		return null;
	};
	const nameOf = (el) => {
		const aria = el.getAttribute("aria-label");
		if (aria && aria.trim()) return aria;
		const by = el.getAttribute("aria-labelledby");
		if (by) { const text = by.split(/\s+/).map((id) => document.getElementById(id)?.innerText ?? "").join(" "); if (text.trim()) return text; }
		if (el.labels && el.labels.length > 0) { const text = [...el.labels].map((label) => label.innerText).join(" "); if (text.trim()) return text; }
		if (el.tagName === "INPUT" && ["button", "submit", "reset"].includes(el.type)) return el.value;
		if (el.tagName === "IMG") return el.alt;
		if (el.tagName !== "SELECT" && el.tagName !== "TEXTAREA" && el.tagName !== "INPUT") { const text = el.innerText; if (text && text.trim()) return text; }
		return el.getAttribute("title") || el.getAttribute("placeholder") || el.querySelector?.("img[alt]")?.alt || "";
	};
	const clickable = new Set();
	const holders = new Set();
	const scan = (root) => {
		for (const el of root.querySelectorAll("*")) {
			if (el.shadowRoot) scan(el.shadowRoot);
			if (SKIP.has(el.tagName)) continue;
			const role = roleOf(el);
			let control = ROLES.has(role) || el.hasAttribute("onclick") || (el.hasAttribute("tabindex") && el.tabIndex >= 0 && el !== document.body);
			if (!control) { const parent = up(el); control = style(el).cursor === "pointer" && (!parent || style(parent).cursor !== "pointer"); }
			if (!control || !shown(el)) continue;
			clickable.add(el);
			for (let parent = up(el); parent && !holders.has(parent); parent = up(parent)) holders.add(parent);
		}
	};
	scan(document);
	const refs = new Map();
	window.__piPocketRefs = refs;
	let count = 0;
	let size = 0;
	let full = false;
	const lines = [];
	const add = (depth, text) => {
		if (full) return;
		const line = "  ".repeat(Math.min(depth, 12)) + text;
		if (size + line.length > MAX) { full = true; return; }
		size += line.length + 1;
		lines.push(line);
	};
	const control = (el, role) => {
		const ref = "e" + ++count;
		refs.set(ref, new WeakRef(el));
		let line = "[" + ref + "] " + (role ?? (style(el).cursor === "pointer" ? "clickable" : el.tagName.toLowerCase()));
		const name = clip(nameOf(el), 80);
		if (name) line += ' "' + name + '"';
		if (role === "link") { const href = el.getAttribute("href"); if (href && !href.startsWith("javascript:")) line += " -> " + clip(href, 90); }
		if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
			const type = el.tagName === "TEXTAREA" ? "textarea" : el.type;
			if (type === "checkbox" || type === "radio") { if (el.checked) line += " (checked)"; }
			else if (!["button", "submit", "reset", "image"].includes(type)) {
				if (el.value) line += ' = "' + (type === "password" ? "••••" : clip(el.value, 60)) + '"';
				else if (el.placeholder && !name.includes(el.placeholder)) line += ' placeholder "' + clip(el.placeholder, 40) + '"';
				if (!["text", "textarea", "search"].includes(type)) line += " [" + type + "]";
			}
		}
		if (el.tagName === "SELECT") {
			const chosen = el.selectedOptions?.[0]?.text;
			if (chosen) line += ' = "' + clip(chosen, 40) + '"';
			const options = [...el.options].map((option) => clip(option.text, 30));
			line += " options: " + options.slice(0, 12).join(" | ") + (options.length > 12 ? " … (" + options.length + ")" : "");
		}
		const expanded = el.getAttribute("aria-expanded");
		if (expanded) line += expanded === "true" ? " (expanded)" : " (collapsed)";
		if (["aria-checked", "aria-selected", "aria-pressed"].some((attr) => el.getAttribute(attr) === "true")) line += " (selected)";
		if (el.disabled || el.getAttribute("aria-disabled") === "true") line += " (disabled)";
		return line;
	};
	const visit = (node, depth) => {
		if (full) return;
		if (node.nodeType === 3) { const text = clip(node.textContent, 200); if (text) add(depth, text); return; }
		if (node.nodeType !== 1) return;
		const el = node;
		if (SKIP.has(el.tagName)) return;
		if (el.tagName === "SLOT") { for (const child of el.assignedNodes({ flatten: true })) visit(child, depth); return; }
		const s = style(el);
		if (s.display === "none") return;
		if (!shown(el) && !holders.has(el)) return;
		const role = roleOf(el);
		if (clickable.has(el)) {
			add(depth, control(el, role));
			if (holders.has(el)) walk(el, depth + 1);
			return;
		}
		if (role === "heading") {
			const level = Number(el.getAttribute("aria-level") ?? el.tagName.slice(1)) || 2;
			add(depth, "#".repeat(Math.min(level, 6)) + " " + clip(el.innerText, 120));
			if (holders.has(el)) walk(el, depth + 1);
			return;
		}
		if (el.tagName === "IMG") { const alt = clip(el.alt, 80); if (alt) add(depth, 'img "' + alt + '"'); return; }
		if (el.tagName === "IFRAME") { add(depth, "iframe " + clip(el.src, 90)); return; }
		if (el.namespaceURI === "http://www.w3.org/2000/svg") { const title = clip(el.querySelector("title")?.textContent, 60); if (title) add(depth, 'svg "' + title + '"'); return; }
		if (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA") return;
		const landmark = LANDMARKS[el.tagName] ?? (el.getAttribute("role") === "dialog" ? "dialog" : undefined);
		if (landmark) {
			const label = el.getAttribute("aria-label");
			add(depth, landmark + (label ? ' "' + clip(label, 60) + '"' : "") + ":");
			walk(el, depth + 1);
			return;
		}
		if (!holders.has(el) && !s.display.startsWith("inline")) {
			const text = el.innerText ?? "";
			if (text.trim() === "") return;
			if (text.length <= 300 || el.children.length === 0) { add(depth, clip(text, 500)); return; }
		}
		walk(el, depth);
	};
	const walk = (el, depth) => { for (const child of (el.shadowRoot ?? el).childNodes) visit(child, depth); };
	if (document.body) walk(document.body, 0);
	const scrolling = document.scrollingElement ?? document.documentElement;
	return { lines: lines.join("\n"), truncated: full, controls: count, scrollY: Math.round(scrollY), scrollHeight: Math.round(scrolling.scrollHeight), innerHeight: Math.round(innerHeight) };
})()`;

/**
 * Finds what Pi points at, scrolls it into view, and returns its middle in screen coordinates (CSS pixels of the
 * visual viewport, which mouse events use), with a short description and what covers it, if anything.
 */
export const LOCATE_SCRIPT = String.raw`(async (target) => {
	const clip = (text, max) => { const flat = String(text ?? "").replace(/\s+/g, " ").trim(); return flat.length > max ? flat.slice(0, max - 1) + "…" : flat; };
	const describe = (el) => {
		const name = clip(el.getAttribute("aria-label") || el.innerText || el.value || el.getAttribute("placeholder") || el.getAttribute("title") || "", 60);
		return el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (name ? ' "' + name + '"' : "");
	};
	let el = null;
	if (target.ref) {
		el = window.__piPocketRefs?.get(target.ref)?.deref() ?? null;
		if (!el || !el.isConnected) throw new Error("No element " + target.ref + " on the page now: take a new snapshot.");
	} else if (target.selector) {
		el = document.querySelector(target.selector);
		if (!el) throw new Error("Nothing matches the selector " + target.selector + ".");
	} else if (target.label) {
		const want = target.label.replace(/\s+/g, " ").trim().toLowerCase();
		const text = (each) => (each.getAttribute("aria-label") || each.innerText || each.value || each.getAttribute("placeholder") || each.getAttribute("title") || "").replace(/\s+/g, " ").trim().toLowerCase();
		const seen = (each) => each.getClientRects().length > 0 && getComputedStyle(each).visibility !== "hidden";
		const controls = [...document.querySelectorAll('a[href], button, input:not([type=hidden]), select, textarea, summary, label, [role], [onclick], [tabindex]')].filter(seen);
		el = controls.find((each) => text(each) === want) ?? controls.find((each) => text(each).includes(want)) ?? null;
		if (!el) {
			const all = [...document.body.querySelectorAll("*")].filter((each) => each.children.length === 0 && seen(each) && text(each).includes(want));
			el = all.find((each) => text(each) === want) ?? all[0] ?? null;
		}
		if (!el) throw new Error('Nothing on the page says "' + target.label + '".');
		// A label stands for its field.
		if (el.tagName === "LABEL" && el.control) el = el.control;
	}
	el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
	await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
	const box = el.getBoundingClientRect();
	if (box.width === 0 && box.height === 0) throw new Error(describe(el) + " is not visible.");
	const x = box.left + box.width / 2;
	const y = box.top + box.height / 2;
	const hit = document.elementFromPoint(x, y);
	const covered = hit && hit !== el && !el.contains(hit) && !hit.contains(el) ? describe(hit) : undefined;
	const view = window.visualViewport;
	const scale = view?.scale ?? 1;
	return { x: (x - (view?.offsetLeft ?? 0)) * scale, y: (y - (view?.offsetTop ?? 0)) * scale, label: describe(el), covered, editable: el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) };
})`;

/**
 * Selects what the focused field holds, so typed text replaces it: "selected", "empty", "none" (not a field), or "keys"
 * for a field a script cannot select (email, number), which the editor's select-all shortcut selects instead.
 */
export const SELECT_ALL_SCRIPT = String.raw`(() => {
	const el = document.activeElement;
	if (!el) return "none";
	if (["INPUT", "TEXTAREA"].includes(el.tagName)) {
		if (el.value === "") return "empty";
		try { el.select(); return "selected"; } catch { return "keys"; }
	}
	if (el.isContentEditable) {
		if ((el.textContent ?? "") === "") return "empty";
		const range = document.createRange(); range.selectNodeContents(el); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
		return "selected";
	}
	return "none";
})()`;

/** Picks an option of a select element by its value or text. */
export const SELECT_OPTION_SCRIPT = String.raw`((target, wanted) => {
	const el = target.ref ? window.__piPocketRefs?.get(target.ref)?.deref() : target.selector ? document.querySelector(target.selector) : document.activeElement;
	if (!el) throw new Error("No such element: take a new snapshot.");
	if (el.tagName !== "SELECT") throw new Error("That is a " + el.tagName.toLowerCase() + ", not a select element: click it instead.");
	const want = String(wanted).trim().toLowerCase();
	const option = [...el.options].find((each) => each.value === wanted) ?? [...el.options].find((each) => each.text.trim().toLowerCase() === want) ?? [...el.options].find((each) => each.text.toLowerCase().includes(want));
	if (!option) throw new Error('No option "' + wanted + '". Options: ' + [...el.options].map((each) => each.text.trim()).join(" | "));
	el.value = option.value;
	el.dispatchEvent(new Event("input", { bubbles: true }));
	el.dispatchEvent(new Event("change", { bubbles: true }));
	return option.text.trim();
})`;

/** A value as text for Pi: JSON, with elements as their opening tags. */
export const DESCRIBE_FUNCTION = String.raw`function () {
	const seen = new WeakSet();
	const node = (value) => value.nodeType === 1 ? value.outerHTML.slice(0, 200) + (value.outerHTML.length > 200 ? "…" : "") : String(value.textContent ?? value.nodeName);
	if (this instanceof Node) return node(this);
	try {
		return JSON.stringify(this, (key, value) => {
			if (value instanceof Node) return node(value);
			if (typeof value === "function") return "[function " + (value.name || "anonymous") + "]";
			if (typeof value === "bigint") return value.toString() + "n";
			if (value && typeof value === "object") { if (seen.has(value)) return "[circular]"; seen.add(value); }
			return value;
		}, 2) ?? String(this);
	} catch (error) {
		return String(this);
	}
}`;
