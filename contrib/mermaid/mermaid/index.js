export const pocketApi = 1;

// No message can change these settings through directives or front matter.
export const configuration = {
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    htmlLabels: false,
    maxTextSize: 20_000,
    maxEdges: 200,
    theme: "default",
    flowchart: { htmlLabels: false },
    secure: [
        "securityLevel",
        "startOnLoad",
        "suppressErrorRendering",
        "htmlLabels",
        "maxTextSize",
        "maxEdges",
        "theme",
        "flowchart",
        "secure",
    ],
};

// This is a conservative refusal check, not a CSS sanitizer. Mermaid inserts source CSS while
// measuring its SVG. Decode escapes before checking for resource functions and comment openers.
export function decodedCss(text) {
    return text
        .replace(/\\(?:\r\n|[\n\r\f])/g, "")
        .replace(/\\([\da-f]{1,6})(?:\r\n|[\t\n\r\f ])?|\\([^\n\r\f])/gi, (_match, hex, char) => {
            const code = Number.parseInt(hex, 16);

            return hex ? String.fromCodePoint(code > 0 && code <= 0x10ffff ? code : 0xfffd) : char;
        });
}

const resourceFunction = /(?:url|image-set|src)\s*\(|@import\b/i;

export function validateSource(text) {
    if (text.length > configuration.maxTextSize) {
        throw new Error("This diagram exceeds the 20,000-character limit.");
    }

    const css = decodedCss(text);

    // A comment opener in a Mermaid label must not hide a later CSS statement from validation.
    if (css.includes("/*") || resourceFunction.test(css)) {
        throw new Error("CSS resource functions, imports, and comment openers are not supported.");
    }

    // Mermaid's extended image nodes load their URL during layout, before SVG sanitization.
    if (/@\s*\{/.test(text)) {
        throw new Error("Extended node definitions, including image nodes, are not supported.");
    }

    if (/%%\s*\{/.test(text) || /^\s*---(?:[\r\n]|$)/.test(text)) {
        throw new Error("Mermaid configuration directives and front matter are not supported.");
    }
}

// Mermaid already sanitizes strict output. Also remove links, images, HTML, and all source-defined
// styles. The extension stylesheet supplies colors, so an existing diagram follows theme changes.
export function cleanSvg(DOMPurify, svg) {
    const fragment = DOMPurify.sanitize(svg, {
        USE_PROFILES: { svg: true },
        FORBID_TAGS: [
            "style",
            "foreignObject",
            "image",
            "a",
            "script",
            "animate",
            "animateMotion",
            "animateTransform",
            "set",
        ],
        FORBID_ATTR: ["tabindex"],
        RETURN_DOM_FRAGMENT: true,
    });

    const colors = new Map();
    const colorParser = document.createElement("canvas").getContext("2d");

    for (const element of fragment.querySelectorAll("*")) {
        // Keep chart series distinct, but replace their colors with the app's palette. Never keep CSS.
        for (const property of ["fill", "stroke"]) {
            const color = (
                element.style?.getPropertyValue(property) ||
                element.getAttribute(property) ||
                ""
            ).toLowerCase();

            if (
                /^(#[\da-f]{3,8}|(?:rgb|hsl)a?\([\d\s.,%+-]+\)|[a-z]+)$/.test(color) &&
                !["none", "transparent", "currentcolor", "inherit"].includes(color)
            ) {
                // Canvas normalizes equivalent hex, RGB, HSL, and named colors to one key.
                colorParser.fillStyle = "#000000";
                colorParser.fillStyle = color;
                const key = colorParser.fillStyle;

                if (!colors.has(key)) {
                    colors.set(key, colors.size % 12);
                }

                element.setAttribute(property, `var(--x-mermaid-${colors.get(key)})`);
            }
        }

        element.removeAttribute("style");

        for (const attribute of [...element.attributes]) {
            // Only local references can survive, including marker-end and clip-path.
            if (
                (/href$/i.test(attribute.name) && !/^#[\w.-]+$/.test(attribute.value)) ||
                decodedCss(attribute.value).includes("/*") ||
                (resourceFunction.test(decodedCss(attribute.value)) &&
                    !/^url\(#[\w.-]+\)$/.test(decodedCss(attribute.value)))
            ) {
                element.removeAttribute(attribute.name);
            }
        }
    }

    const diagram = fragment.querySelector("svg");

    if (!diagram) {
        throw new Error("Mermaid returned no SVG diagram.");
    }

    diagram.setAttribute("role", "img");
    diagram.setAttribute("aria-label", "Mermaid diagram; the source is available below");
    diagram.removeAttribute("width");
    diagram.removeAttribute("height");

    return diagram;
}

export default function setup(pocket) {
    if (typeof pocket.codeBlock !== "function") {
        throw new Error(
            "Mermaid needs the fenced-code renderer API. Pi Pocket 0.27.0 has no such API.",
        );
    }

    pocket.style("style.css");

    const { html, useEffect, useRef, useState } = pocket;
    let vendor;
    let queue = Promise.resolve();
    let sequence = 0;
    const prefix = `x-mermaid-${Math.random().toString(36).slice(2)}`;

    function Diagram({ text }) {
        const target = useRef(null);
        const staging = useRef(null);
        const [status, setStatus] = useState({ text, loading: true });

        useEffect(() => {
            let cancelled = false;
            const output = target.current;
            const container = staging.current;

            output.replaceChildren();
            setStatus({ text, loading: true });
            queue = queue.then(async () => {
                if (cancelled) {
                    return;
                }

                try {
                    validateSource(text);
                    vendor ??= import("./vendor.js");
                    const { mermaid, DOMPurify } = await vendor;

                    if (cancelled) {
                        return;
                    }

                    mermaid.initialize(configuration);
                    const result = await mermaid.render(`${prefix}-${++sequence}`, text, container);
                    const svg = cleanSvg(DOMPurify, result.svg);

                    if (!cancelled) {
                        output.replaceChildren(svg);
                        setStatus({ text, loading: false });
                    }
                } catch (error) {
                    if (!cancelled) {
                        setStatus({
                            text,
                            loading: false,
                            error: `Mermaid could not render this diagram: ${String(error?.message ?? error).slice(0, 1000)}`,
                        });
                    }
                } finally {
                    container.replaceChildren();
                }
            });

            return () => {
                cancelled = true;
                output.replaceChildren();
            };
        }, [text]);

        const current = status.text === text ? status : { loading: true };

        return html`<div class="x-mermaid">
            ${current.loading && html`<p class="muted" role="status">Rendering Mermaid diagram…</p>`}
            ${
                current.error &&
                html`<pre class="x-mermaid-error error-box" role="alert">${current.error}</pre>`
            }
            <div
                class="x-mermaid-diagram"
                role="region"
                aria-label="Mermaid diagram"
                tabindex="0"
                ref=${target}
            ></div>
            <div class="x-mermaid-staging" aria-hidden="true" ref=${staging}></div>
        </div>`;
    }

    pocket.codeBlock({ language: "mermaid", component: Diagram });
}
