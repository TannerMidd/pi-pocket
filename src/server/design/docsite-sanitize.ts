// The allowlist that the page applies to a component's markup and CSS (project text) before it shows them. The page builds a new tree from the lists below, so nothing they do not name can reach the page, and no new browser element is let in by missing from a denylist.
// The lists are data here and text in the page's script (`SANITIZER_JS`); a test runs probes through the real thing in Chromium.

export const HTML_ELEMENTS =
    "a abbr address article aside b bdi bdo blockquote br button caption cite code col colgroup dd del details dfn div dl dt em fieldset figcaption figure footer h1 h2 h3 h4 h5 h6 header hgroup hr i img input ins kbd label legend li main mark meter nav ol optgroup option output p pre progress q rp rt ruby s samp section select small span strong style sub summary sup table tbody td textarea tfoot th thead time tr u ul var wbr".split(
        " ",
    );

/** SVG elements. No animation, `foreignObject`, script, or image. */
export const SVG_ELEMENTS =
    "svg g path circle ellipse rect line polyline polygon text tspan defs lineargradient radialgradient stop clippath mask pattern symbol title desc use marker a style filter fegaussianblur feoffset fecolormatrix femerge femergenode feflood fecomposite feblend fedropshadow".split(
        " ",
    );

export const DROPPED_ELEMENTS =
    "script iframe frame frameset object embed template noscript math foreignobject animate set animatetransform animatemotion mpath discard portal applet link meta base head".split(
        " ",
    );

export const GLOBAL_ATTRIBUTES = "class id role title lang dir tabindex hidden style".split(" ");

export const HTML_ATTRIBUTES =
    "type value placeholder disabled checked selected readonly required for alt width height colspan rowspan min max step rows cols open label multiple maxlength size scope headers datetime name href src abbr cite span start reversed".split(
        " ",
    );

/** Attributes of SVG elements. None names an animation target or value (`attributeName`, `to`, `from`, `by`). */
export const SVG_ATTRIBUTES =
    "viewbox preserveaspectratio xmlns d fill fill-opacity fill-rule clip-rule stroke stroke-width stroke-linecap stroke-linejoin stroke-dasharray stroke-dashoffset stroke-opacity stroke-miterlimit opacity transform cx cy r rx ry x y x1 y1 x2 y2 points width height offset stop-color stop-opacity gradientunits gradienttransform patternunits patterntransform clippathunits maskunits clip-path mask filter text-anchor dominant-baseline font-size font-family font-weight letter-spacing dx dy rotate textlength marker-start marker-mid marker-end markerwidth markerheight refx refy orient fx fy pathlength vector-effect shape-rendering color display visibility overflow in in2 result stddeviation mode type values flood-color flood-opacity href xlink:href".split(
        " ",
    );

/** Presentation attributes whose value may name another element of the picture, as `url(#id)` and nothing else. */
const URL_ATTRIBUTES = "fill stroke clip-path mask filter marker-start marker-mid marker-end".split(
    " ",
);

export const SANITIZER_JS = `
var HTML_NS = "http://www.w3.org/1999/xhtml";
var SVG_NS = "http://www.w3.org/2000/svg";
function setOf(list) { var set = {}; list.forEach(function (name) { set[name] = true; }); return set; }
var OK_HTML = setOf(${JSON.stringify(HTML_ELEMENTS)});
var OK_SVG = setOf(${JSON.stringify(SVG_ELEMENTS)});
var DROPPED = setOf(${JSON.stringify(DROPPED_ELEMENTS)});
var OK_GLOBAL = setOf(${JSON.stringify(GLOBAL_ATTRIBUTES)});
var OK_HTML_ATTR = setOf(${JSON.stringify(HTML_ATTRIBUTES)});
var OK_SVG_ATTR = setOf(${JSON.stringify(SVG_ATTRIBUTES)});
var URL_ATTR = setOf(${JSON.stringify(URL_ATTRIBUTES)});
var MAX_NODES = 4000;
var MAX_DEPTH = 40;

// CSS. A regex that looks for bad words misses an escape (\\69mport, u\\72l) and a function that takes an address
// (image-set, image, cross-fade, element, src), so this reads the CSS as rules and declarations and keeps only what is
// safe: a declaration is checked after its escapes are decoded, and it goes whole when it holds a function that fetches
// or an address that is not "#id" or a small image in the text itself. Only @media, @supports, @keyframes, and
// @container rules stay; every other at-rule (@import, @font-face, @namespace, @property, @page, ...) goes.
function decodeCss(text) {
    return text.replace(/\\\\([0-9a-fA-F]{1,6})[ \\t\\n\\r\\f]?|\\\\([^\\n])/g, function (all, hex, character) {
        if (hex) { var code = parseInt(hex, 16); return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "\\ufffd"; }
        return character;
    });
}
function badCss(text) {
    var decoded = decodeCss(text);
    if (/image-set|image\\s*\\(|cross-fade|element\\s*\\(|(^|[^\\w-])src\\s*\\(|paint\\s*\\(|expression\\s*\\(|behavior\\s*:|-moz-binding|@import|javascript:|vbscript:/i.test(decoded)) { return true; }
    var addresses = decoded.match(/url\\s*\\(/gi);
    if (addresses) {
        var allowed = decoded.match(/url\\(\\s*(["']?)(#[\\w:.-]+|data:image\\/(png|gif|jpeg|webp)[;,][^)"']*)\\1\\s*\\)/gi);
        if (!allowed || allowed.length !== addresses.length) { return true; }
    }
    return false;
}
function skipQuoted(text, at) {
    var quote = text.charAt(at);
    at++;
    while (at < text.length && text.charAt(at) !== quote) { at += text.charAt(at) === "\\\\" ? 2 : 1; }
    return at;
}
// A block's items, each up to a ";" or a "{" (outside strings and parentheses). \`inRule\` says that a bare item is a
// declaration (inside a style rule, or a keyframe); at the top a bare item is an at-rule statement, and goes.
function cleanBlock(text, inRule, depth) {
    var out = "";
    var i = 0;
    var n = text.length;
    if (depth > 8) { return ""; }
    while (i < n) {
        var start = i;
        var paren = 0;
        while (i < n) {
            var c = text.charAt(i);
            if (c === '"' || c === "'") { i = skipQuoted(text, i); }
            else if (c === "\\\\") { i++; }
            else if (c === "(") { paren++; }
            else if (c === ")") { if (paren > 0) { paren--; } }
            else if (paren === 0 && (c === ";" || c === "{" || c === "}")) { break; }
            i++;
        }
        var head = text.slice(start, i).trim();
        var end = text.charAt(i);
        if (end === "{") {
            var level = 1;
            var j = i + 1;
            while (j < n && level > 0) {
                var d = text.charAt(j);
                if (d === '"' || d === "'") { j = skipQuoted(text, j); }
                else if (d === "\\\\") { j++; }
                else if (d === "{") { level++; }
                else if (d === "}") { level--; }
                j++;
            }
            var inner = text.slice(i + 1, level === 0 ? j - 1 : j);
            i = j;
            if (!head || badCss(head)) { continue; }
            if (head.charAt(0) === "@") {
                var name = (/^@([\\w-]+)/.exec(decodeCss(head)) || [])[1];
                name = name ? name.toLowerCase() : "";
                if (/^(-webkit-)?keyframes$/.test(name) || name === "media" || name === "supports" || name === "container") {
                    out += head + "{" + cleanBlock(inner, false, depth + 1) + "}";
                }
            } else {
                out += head + "{" + cleanBlock(inner, true, depth + 1) + "}";
            }
        } else {
            if (end) { i++; }
            if (inRule && head && head.indexOf(":") !== -1 && !badCss(head)) { out += head + ";"; }
        }
    }
    return out;
}
function cleanCss(text) { return cleanBlock(String(text).replace(/\\/\\*[\\s\\S]*?(\\*\\/|$)/g, ""), false, 0); }
function cleanDeclarations(text) { return cleanBlock(String(text).replace(/\\/\\*[\\s\\S]*?(\\*\\/|$)/g, ""), true, 0); }

function okValue(name, value, tag) {
    var flat = value.replace(/[\\u0000-\\u0020\\u007f-\\u009f]+/g, "").toLowerCase();
    if (/(javascript|vbscript|livescript):|data:(text|application)|<\\s*script/.test(flat)) { return false; }
    if (name === "href" || name === "xlink:href") { return (tag === "a" || tag === "use") && /^#[\\w:.-]*$/.test(value.trim()); }
    if (name === "src") { return tag === "img" && /^data:image\\/(png|gif|jpeg|webp);base64,[a-z0-9+\\/=]*$/i.test(value.trim()); }
    if (URL_ATTR[name] && /url\\s*\\(/i.test(value)) { return /^\\s*url\\(\\s*#[\\w:.-]+\\s*\\)\\s*$/.test(value); }
    if (name === "values") { return tag === "fecolormatrix"; }
    return true;
}

function copyAttributes(from, to, svg, tag) {
    Array.prototype.slice.call(from.attributes).forEach(function (attribute) {
        var name = attribute.name.toLowerCase();
        var listed = OK_GLOBAL[name] || (svg ? OK_SVG_ATTR[name] : OK_HTML_ATTR[name]) || /^(aria|data)-[a-z0-9._-]+$/.test(name);
        if (!listed) { return; }
        var value = attribute.value;
        if (name === "style") { value = cleanDeclarations(value); }
        else if (!okValue(name, value, tag)) { return; }
        try { to.setAttributeNS(attribute.namespaceURI, attribute.name, value); } catch (error) { }
    });
}

function copyChildren(from, to, state, depth) {
    Array.prototype.slice.call(from.childNodes).forEach(function (child) {
        if (state.count > MAX_NODES || depth > MAX_DEPTH) { return; }
        if (child.nodeType === 3) { to.appendChild(document.createTextNode(child.data)); state.count++; return; }
        if (child.nodeType !== 1) { return; }
        var svg = child.namespaceURI === SVG_NS;
        if (!svg && child.namespaceURI !== HTML_NS) { return; }
        var tag = child.localName.toLowerCase();
        if (DROPPED[tag] || (!svg && tag === "title")) { return; }
        if (!(svg ? OK_SVG : OK_HTML)[tag]) { copyChildren(child, to, state, depth + 1); return; }
        var out = svg ? document.createElementNS(SVG_NS, child.localName) : document.createElement(tag);
        state.count++;
        copyAttributes(child, out, svg, tag);
        to.appendChild(out);
        if (tag === "style") { out.textContent = cleanCss(child.textContent); } else { copyChildren(child, out, state, depth + 1); }
    });
}

function cleanInto(parsed, to) {
    var state = { count: 0 };
    copyChildren(parsed.head, to, state, 0);
    copyChildren(parsed.body, to, state, 0);
}
`;
