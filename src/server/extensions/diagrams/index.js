import DOMPurify from "dompurify";

const MAX_DIAGRAM_SOURCE_LENGTH = 50_000;
const STREAMING_RENDER_INTERVAL = 250;
const MAX_TEX_LENGTH = 20_000;
const MAX_TEX_OUTPUT_LENGTH = 250_000;
const SVG_NS = "http://www.w3.org/2000/svg";
const CSS_URL_ATTRIBUTES = new Set([
    "fill",
    "stroke",
    "filter",
    "mask",
    "clip-path",
    "marker-start",
    "marker-mid",
    "marker-end",
    "cursor",
]);
const DIAGRAM_OPTIONS = {
    links: false,
    images: false,
    limit: MAX_DIAGRAM_SOURCE_LENGTH,
    outputLimit: 1_000_000,
    maxEdges: 2_000,
};
const UNSAFE_STYLE =
    /(?:expression\s*\(|@import\b|javascript\s*:|vbscript\s*:|-moz-binding\b|behavior\s*:)/i;

function hasExternalUrl(value) {
    for (const match of value.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi)) {
        if (!(match[1] ?? match[2] ?? match[3] ?? "").trim().startsWith("#")) {
            return true;
        }
    }

    return false;
}

function cleanInlineStyle(element) {
    const raw = element.getAttribute("style") ?? "";

    if (UNSAFE_STYLE.test(raw)) {
        element.removeAttribute("style");

        return;
    }

    const style = element.style;
    const properties = Array.from({ length: style.length }, (_, index) => style.item(index));

    for (const property of properties) {
        const value = style.getPropertyValue(property);

        if (UNSAFE_STYLE.test(`${property}:${value}`) || hasExternalUrl(value)) {
            style.removeProperty(property);
        }
    }

    if (style.length === 0) {
        element.removeAttribute("style");
    } else {
        element.setAttribute("style", style.cssText);
    }
}

function hasExternalCssUrl(probe, name, value) {
    probe.style.cssText = "";
    probe.style.setProperty(name, value);

    return hasExternalUrl(probe.style.getPropertyValue(name));
}

export function sanitizeSvg(svg) {
    const safe = DOMPurify.sanitize(svg, {
        USE_PROFILES: { svg: true, svgFilters: true },
        FORBID_TAGS: ["a", "image", "foreignobject", "style"],
        FORBID_ATTR: ["href", "xlink:href", "src", "xml:base"],
        RETURN_TRUSTED_TYPE: false,
    });
    const template = document.createElement("template");
    const cssProbe = document.createElementNS(SVG_NS, "svg");

    template.innerHTML = safe;

    for (const element of template.content.querySelectorAll("*")) {
        for (const attribute of [...element.attributes]) {
            const name = attribute.name.toLowerCase();

            if (name === "style") {
                cleanInlineStyle(element);

                continue;
            }

            if (
                name === "href" ||
                name === "xlink:href" ||
                name === "src" ||
                name === "xml:base" ||
                hasExternalUrl(attribute.value) ||
                (CSS_URL_ATTRIBUTES.has(name) && hasExternalCssUrl(cssProbe, name, attribute.value))
            ) {
                element.removeAttribute(attribute.name);
            }
        }
    }

    return template.innerHTML;
}

function sourceBlock(h, source, label, error = false) {
    return h(
        "pre",
        {
            className: error ? "pocket-diagrams-error" : "pocket-diagrams-source",
            "aria-label": `${label} source`,
            ...(error ? { role: "status" } : {}),
        },
        h("code", null, source),
    );
}

function renderMath(katex, source, display) {
    const html = katex.renderToString(source, {
        displayMode: display,
        throwOnError: true,
        strict: "ignore",
        trust: false,
        maxExpand: 1_000,
        maxSize: 5,
    });

    if (html.length > MAX_TEX_OUTPUT_LENGTH) {
        throw new Error("Math output exceeds the limit.");
    }

    return DOMPurify.sanitize(html, {
        RETURN_TRUSTED_TYPE: false,
        ADD_TAGS: ["semantics", "annotation"],
        ADD_ATTR: ["encoding"],
    });
}

export default function (pocket) {
    const { h, useEffect, useRef, useState } = pocket;
    const runtime = { active: true, pele: null, katex: null, katexStyle: false };
    const loadPele = () => (runtime.pele ??= import("/vendor/pele.mjs"));
    const loadKatex = () =>
        (runtime.katex ??= import("/vendor/katex.mjs").then((module) => {
            if (runtime.active && !runtime.katexStyle) {
                pocket.style("math.css");
                runtime.katexStyle = true;
            }

            return module;
        }));

    function Mermaid({ source, lang, streaming }) {
        const text = typeof source === "string" ? source : "";
        const label = typeof lang === "string" ? lang : "Mermaid";
        const [result, setResult] = useState(null);
        const lastRenderAt = useRef(0);
        const timer = useRef(null);

        useEffect(() => {
            let current = true;

            const fail = () => {
                if (current && runtime.active) {
                    setResult((previous) =>
                        previous?.html ? previous : { source: text, error: true },
                    );
                }
            };

            if (text.length <= MAX_DIAGRAM_SOURCE_LENGTH) {
                const delay = streaming
                    ? Math.max(
                          0,
                          STREAMING_RENDER_INTERVAL - (performance.now() - lastRenderAt.current),
                      )
                    : 0;

                timer.current = setTimeout(() => {
                    timer.current = null;
                    lastRenderAt.current = performance.now();

                    void loadPele()
                        .then(({ render }) => {
                            if (!current || !runtime.active) {
                                return;
                            }

                            try {
                                const { svg } = render(text, DIAGRAM_OPTIONS);
                                const html = sanitizeSvg(svg);

                                if (current && runtime.active) {
                                    setResult({ source: text, html });
                                }
                            } catch {
                                fail();
                            }
                        })
                        .catch(fail);
                }, delay);
            }

            return () => {
                current = false;

                if (timer.current !== null) {
                    clearTimeout(timer.current);
                    timer.current = null;
                }
            };
        }, [text, streaming]);

        if (result?.html) {
            return h("div", {
                className: "pocket-diagrams-output",
                role: "img",
                "aria-label": `${label} diagram`,
                dangerouslySetInnerHTML: { __html: result.html },
            });
        }

        const error =
            text.length > MAX_DIAGRAM_SOURCE_LENGTH ||
            (!streaming && result?.source === text && result.error);

        return sourceBlock(h, text, label, error);
    }

    function MathFence({ source, lang, streaming }) {
        const text = typeof source === "string" ? source : "";
        const label = typeof lang === "string" ? lang : "Math";
        const [result, setResult] = useState(null);

        useEffect(() => {
            let current = true;

            setResult(null);

            if (streaming || text.length > MAX_TEX_LENGTH) {
                return () => {
                    current = false;
                };
            }

            void loadKatex()
                .then((katex) => {
                    if (!current || !runtime.active) {
                        return;
                    }

                    const html = renderMath(katex, text, true);

                    if (current && runtime.active) {
                        setResult({ source: text, html });
                    }
                })
                .catch(() => {
                    if (current && runtime.active) {
                        setResult({ source: text, error: true });
                    }
                });

            return () => {
                current = false;
            };
        }, [text, streaming]);

        if (streaming || text.length > MAX_TEX_LENGTH) {
            return sourceBlock(h, text, label, text.length > MAX_TEX_LENGTH);
        }

        if (result?.source !== text) {
            return sourceBlock(h, text, label);
        }

        if (result.error) {
            return sourceBlock(h, text, label, true);
        }

        return h("div", {
            className: "pocket-diagrams-math-fence",
            role: "math",
            "aria-label": `${label} expression`,
            "data-tex": result.source,
            "data-lang": "math-display",
            dangerouslySetInnerHTML: { __html: result.html },
        });
    }

    function mountMath(element, tex, display) {
        const source = typeof tex === "string" ? tex : "";

        element.textContent = source;

        if (source.length > MAX_TEX_LENGTH) {
            return;
        }

        void loadKatex()
            .then((katex) => {
                if (!runtime.active || !element.isConnected || element.textContent !== source) {
                    return;
                }

                element.innerHTML = renderMath(katex, source, display);
                element.classList.add("pocket-diagrams-math");

                if (display) {
                    element.classList.add("pocket-diagrams-math-display");
                }
            })
            .catch(() => {
                if (runtime.active && element.isConnected) {
                    element.textContent = source;
                }
            });
    }

    pocket.style("style.css");
    const mermaid = pocket.fence({
        id: "diagrams-mermaid",
        langs: ["mermaid"],
        component: Mermaid,
    });
    const mathFence = pocket.fence({
        id: "diagrams-math",
        langs: ["math", "latex", "tex"],
        component: MathFence,
    });
    const math = pocket.mathInline({ id: "diagrams-katex", mount: mountMath });

    return () => {
        runtime.active = false;
        math.remove();
        mathFence.remove();
        mermaid.remove();
    };
}
