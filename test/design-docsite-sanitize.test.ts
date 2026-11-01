import assert from "node:assert/strict";
import { test } from "node:test";
import { SANITIZER_JS } from "../src/server/design/docsite-sanitize.ts";

// The script is the page's own text; its CSS functions need no browser, so they run here as they are.
const { cleanCss, cleanDeclarations } = new Function(
    `${SANITIZER_JS}; return { cleanCss, cleanDeclarations };`,
)() as { cleanCss: (text: string) => string; cleanDeclarations: (text: string) => string };

test("a declaration with a function that fetches goes whole, with the others kept", () => {
    for (const bad of [
        "border-image: image-set('https://evil.example/f2' 1x)",
        "background: -webkit-image-set(url(https://evil.example/a) 1x)",
        'background-image: image("https://evil.example/i.png")',
        "background: cross-fade(url(#a), url(https://evil.example/b), 50%)",
        "background: element(#other)",
        'background: src("https://evil.example/s")',
        "mask-image: paint(worklet)",
        "background: url(https://evil.example/x.png)",
        "background: url('//evil.example/x.png')",
        "list-style-image: url(https://evil.example/x.png)",
        "cursor: url(https://evil.example/x.cur), auto",
        "background: url(data:text/html,<b>x</b>)",
        "background: url(data:image/svg+xml,<svg/>)",
        "background: url(javascript:window.__ran=1)",
        "background: url(x.png)",
        "width: expression(window.__ran=1)",
        "behavior: url(x.htc)",
        "-moz-binding: url(x.xml#b)",
    ]) {
        assert.equal(cleanCss(`.a{${bad};color:red}`), ".a{color:red;}", bad);
        assert.equal(cleanDeclarations(`${bad};color:red`), "color:red;", bad);
    }
});

test("a CSS escape does not hide a bad word: the declaration is checked after its escapes are decoded", () => {
    for (const bad of [
        "background: u\\72l(https://evil.example/x)",
        "background: \\75rl(https://evil.example/x)",
        "background: u\\000072l(https://evil.example/x)",
        "background: ur\\6c (https://evil.example/x)",
        "border-image: \\69mage-set('https://evil.example/x' 1x)",
        "border-image: image\\2d set('https://evil.example/x' 1x)",
        "background: cross\\2dfade(url(#a), url(https://evil.example/b), 50%)",
        "background: \\73 rc('https://evil.example/s')",
        "background: url(\\68ttps://evil.example/x)",
    ]) {
        assert.equal(cleanCss(`.a{${bad};color:red}`), ".a{color:red;}", bad);
    }

    assert.equal(
        cleanCss('@\\69mport "https://evil.example/c.css";.a{color:red}'),
        ".a{color:red;}",
    );
    assert.equal(
        cleanCss("@\\66ont-face{src:url(https://evil.example/f)}.a{color:red}"),
        ".a{color:red;}",
    );
    assert.equal(
        cleanCss('.a::before{content:"\\2713";color:red}'),
        '.a::before{content:"\\2713";color:red;}',
    );
    assert.equal(cleanCss(".sm\\:flex{display:flex}"), ".sm\\:flex{display:flex;}");
});

test("an address to a part of the picture or to a small image in the text stays; no other address does", () => {
    assert.equal(
        cleanCss(".a{fill:url(#grad);clip-path:url(#clip)}"),
        ".a{fill:url(#grad);clip-path:url(#clip);}",
    );
    assert.equal(
        cleanCss('.a{background:url("data:image/png;base64,iVBORw0KGgo=")}'),
        '.a{background:url("data:image/png;base64,iVBORw0KGgo=");}',
    );
    assert.equal(
        cleanCss(".a{background:url(data:image/gif;base64,R0lG) , url(https://evil.example/x)}"),
        ".a{}",
        "one bad address drops the declaration",
    );
});

test("only @media, @supports, @keyframes, and @container stay, and their rules are cleaned too", () => {
    assert.equal(
        cleanCss(
            "@media (min-width:600px){.a{background:url(https://evil.example/x);color:red}.b{color:blue}}",
        ),
        "@media (min-width:600px){.a{color:red;}.b{color:blue;}}",
    );
    assert.equal(
        cleanCss("@supports (display:grid){.a{display:grid}}"),
        "@supports (display:grid){.a{display:grid;}}",
    );
    assert.equal(
        cleanCss("@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}"),
        "@keyframes spin{from{transform:rotate(0);}to{transform:rotate(360deg);}}",
    );
    assert.equal(
        cleanCss("@container card (min-width:300px){.a{padding:4px}}"),
        "@container card (min-width:300px){.a{padding:4px;}}",
    );
    assert.equal(
        cleanCss("@media (min-width:1px){@media (min-width:2px){.a{color:red}}}"),
        "@media (min-width:1px){@media (min-width:2px){.a{color:red;}}}",
    );

    for (const gone of [
        '@import "https://evil.example/a.css";',
        "@import url(https://evil.example/a.css) screen;",
        "@font-face{font-family:f;src:url(https://evil.example/f.woff2)}",
        "@namespace svg url(http://www.w3.org/2000/svg);",
        "@charset 'utf-8';",
        "@page{margin:0}",
        "@property --x{syntax:'<length>';inherits:false;initial-value:0}",
        "@font-feature-values f{@styleset{a:1}}",
        "@document url(https://evil.example/){.a{color:red}}",
        "@-moz-document url-prefix(){.a{color:red}}",
        "@layer base{.a{color:red}}",
    ]) {
        assert.equal(cleanCss(`${gone}.keep{color:red}`), ".keep{color:red;}", gone);
    }
});

test("comments, strings, and broken text cannot hide or break it", () => {
    assert.equal(cleanCss(".a{/* a } b */color:red}"), ".a{color:red;}");
    assert.equal(
        cleanCss(".a{background:ur/**/l(https://evil.example/x);color:red}"),
        ".a{color:red;}",
    );
    assert.equal(cleanCss('.a{content:"}{;";color:red}'), '.a{content:"}{;";color:red;}');
    assert.equal(
        cleanCss(".a{background:url(data:image/png;base64,AAAA);color:red}"),
        ".a{background:url(data:image/png;base64,AAAA);color:red;}",
    );

    for (const text of [
        ".a{background:url(https://evil.example/x",
        ".a{color:red",
        "@media (x){.a{color:red",
        '.a{content:"unclosed',
        "}}}{{{;;;",
        "",
        "@",
        "{",
    ]) {
        assert.doesNotMatch(cleanCss(text), /evil|url\(https/);
    }

    const deep = cleanCss(`${"@media (x){".repeat(20)}.a{color:red}${"}".repeat(20)}`);

    assert.doesNotMatch(deep, /\.a/);
    assert.ok((deep.match(/@media/g) ?? []).length <= 9);
    assert.equal(
        cleanDeclarations("width:80px;background:url(https://evil.example/x.png);color:red"),
        "width:80px;color:red;",
    );
    assert.equal(cleanDeclarations("border-image:image-set('https://evil.example/f' 1x)"), "");
});
