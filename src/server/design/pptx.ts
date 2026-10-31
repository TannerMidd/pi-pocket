/** Image-backed PowerPoint decks with searchable speaker notes; widescreen by default. */
import { zip } from "../zip.ts";

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE_R = "http://schemas.openxmlformats.org/package/2006/relationships";
const CONTENT_TYPES = "http://schemas.openxmlformats.org/package/2006/content-types";
const MIME = "application/vnd.openxmlformats-officedocument.presentationml.";
const WIDTH = 12192000;
const NS = `xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}"`;
const COLOR_MAP =
    'accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk2"';

/** Remove characters XML 1.0 cannot represent, then escape markup. */
function escapeXml(text: string): string {
    return text
        .replace(/[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/gu, "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

function relationships(items: [id: string, kind: string, target: string][]): string {
    return `<Relationships xmlns="${PACKAGE_R}">${items
        .map(
            ([id, kind, target]) =>
                `<Relationship Id="${id}" Type="${R}/${kind}" Target="${target}"/>`,
        )
        .join("")}</Relationships>`;
}

function shapeTree(shapes = ""): string {
    return `<p:spTree>
        <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
        <p:grpSpPr><a:xfrm>
            <a:off x="0" y="0"/><a:ext cx="0" cy="0"/>
            <a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/>
        </a:xfrm></p:grpSpPr>${shapes}
    </p:spTree>`;
}

function notesShapes(text: string): string {
    const paragraphs = text
        .split(/\r\n|\r|\n/)
        .map(
            (line) => `<a:p><a:r><a:rPr lang="en-US"/>
                <a:t xml:space="preserve">${escapeXml(line)}</a:t>
            </a:r><a:endParaRPr lang="en-US"/></a:p>`,
        )
        .join("");

    return shapeTree(`<p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="Slide Image"/>
            <p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr>
            <p:nvPr><p:ph type="sldImg" idx="2"/></p:nvPr>
        </p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="685800" y="1143000"/>
            <a:ext cx="5486400" cy="3086100"/></a:xfrm>
            <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
        </p:spPr>
    </p:sp><p:sp>
        <p:nvSpPr><p:cNvPr id="3" name="Notes"/><p:cNvSpPr/>
            <p:nvPr><p:ph type="body" idx="3"/></p:nvPr>
        </p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="685800" y="4457700"/>
            <a:ext cx="5486400" cy="3771900"/></a:xfrm>
        </p:spPr>
        <p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs}</p:txBody>
    </p:sp>`);
}

function theme(): string {
    const colors = [
        ["dk1", "000000"],
        ["lt1", "FFFFFF"],
        ["dk2", "1F2937"],
        ["lt2", "F3F4F6"],
        ["accent1", "2563EB"],
        ["accent2", "16A34A"],
        ["accent3", "9333EA"],
        ["accent4", "EA580C"],
        ["accent5", "0891B2"],
        ["accent6", "DB2777"],
        ["hlink", "0000FF"],
        ["folHlink", "800080"],
    ];
    const fill = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
    const font = '<a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/>';

    return `<a:theme xmlns:a="${A}" name="Pi Pocket">
        <a:themeElements>
            <a:clrScheme name="Pi Pocket">${colors
                .map(([name, color]) => `<a:${name}><a:srgbClr val="${color}"/></a:${name}>`)
                .join("")}</a:clrScheme>
            <a:fontScheme name="Pi Pocket">
                <a:majorFont>${font}</a:majorFont><a:minorFont>${font}</a:minorFont>
            </a:fontScheme>
            <a:fmtScheme name="Pi Pocket">
                <a:fillStyleLst>${fill.repeat(3)}</a:fillStyleLst>
                <a:lnStyleLst>${[6350, 12700, 19050]
                    .map((width) => `<a:ln w="${width}">${fill}<a:prstDash val="solid"/></a:ln>`)
                    .join("")}</a:lnStyleLst>
                <a:effectStyleLst>${"<a:effectStyle><a:effectLst/></a:effectStyle>".repeat(3)}</a:effectStyleLst>
                <a:bgFillStyleLst>${fill.repeat(3)}</a:bgFillStyleLst>
            </a:fmtScheme>
        </a:themeElements>
    </a:theme>`;
}

function imageType(image: Buffer): "png" | "jpeg" {
    if (image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        return "png";
    }

    if (image.length >= 3 && image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff) {
        return "jpeg";
    }

    throw new Error("PPTX slide images must be PNG or JPEG buffers.");
}

/** Create an OPC PowerPoint ZIP. Each image fills a slide at the given aspect ratio; text goes in its notes. */
export function pptx(
    slides: { image: Buffer; text: string }[],
    size: { width: number; height: number } = { width: 16, height: 9 },
): Buffer {
    const scale = Math.min(WIDTH / size.width, WIDTH / size.height);
    const width = Math.round(size.width * scale);
    const height = Math.round(size.height * scale);

    if (
        size.width <= 0 ||
        size.height <= 0 ||
        !Number.isFinite(width) ||
        !Number.isFinite(height) ||
        width < 914400 ||
        height < 914400
    ) {
        throw new Error("PPTX slide dimensions need a finite, supported aspect ratio.");
    }

    const entries: { name: string; bytes: Buffer }[] = [];
    const overrides: string[] = [];
    const imageTypes = new Set<string>();

    const addXml = (name: string, body: string, contentType?: string) => {
        entries.push({ name, bytes: Buffer.from(XML + body, "utf8") });

        if (contentType) {
            overrides.push(`<Override PartName="/${name}" ContentType="${contentType}"/>`);
        }
    };

    const addPart = (name: string, body: string, kind: string) =>
        addXml(name, body, `${MIME}${kind}+xml`);

    addXml(
        "_rels/.rels",
        `<Relationships xmlns="${PACKAGE_R}">
            <Relationship Id="rId1" Type="${R}/officeDocument" Target="ppt/presentation.xml"/>
            <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
            <Relationship Id="rId3" Type="${R}/extended-properties" Target="docProps/app.xml"/>
        </Relationships>`,
    );
    addXml(
        "docProps/core.xml",
        '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>Pi Pocket</dc:creator></cp:coreProperties>',
        "application/vnd.openxmlformats-package.core-properties+xml",
    );
    addXml(
        "docProps/app.xml",
        `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">
            <Application>Pi Pocket</Application><PresentationFormat>On-screen Show (16:9)</PresentationFormat>
            <Slides>${slides.length}</Slides><Notes>${slides.length}</Notes>
        </Properties>`,
        "application/vnd.openxmlformats-officedocument.extended-properties+xml",
    );
    addPart(
        "ppt/presentation.xml",
        `<p:presentation ${NS}>
            <p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
            <p:notesMasterIdLst><p:notesMasterId r:id="rId2"/></p:notesMasterIdLst>
            ${slides.length ? `<p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${3 + i}"/>`).join("")}</p:sldIdLst>` : ""}
            <p:sldSz cx="${width}" cy="${height}" type="${size.width * 9 === size.height * 16 ? "screen16x9" : "custom"}"/>
            <p:notesSz cx="6858000" cy="9144000"/>
        </p:presentation>`,
        "presentation.main",
    );
    addXml(
        "ppt/_rels/presentation.xml.rels",
        relationships([
            ["rId1", "slideMaster", "slideMasters/slideMaster1.xml"],
            ["rId2", "notesMaster", "notesMasters/notesMaster1.xml"],
            ...slides.map((_, i): [string, string, string] => [
                `rId${3 + i}`,
                "slide",
                `slides/slide${i + 1}.xml`,
            ]),
        ]),
    );
    addPart(
        "ppt/slideMasters/slideMaster1.xml",
        `<p:sldMaster ${NS}>
            <p:cSld name="Blank">${shapeTree()}</p:cSld><p:clrMap ${COLOR_MAP}/>
            <p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
            <p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles>
        </p:sldMaster>`,
        "slideMaster",
    );
    addXml(
        "ppt/slideMasters/_rels/slideMaster1.xml.rels",
        relationships([
            ["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"],
            ["rId2", "theme", "../theme/theme1.xml"],
        ]),
    );
    addPart(
        "ppt/slideLayouts/slideLayout1.xml",
        `<p:sldLayout ${NS} type="blank" preserve="1">
            <p:cSld name="Blank">${shapeTree()}</p:cSld>
            <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
        </p:sldLayout>`,
        "slideLayout",
    );
    addXml(
        "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
        relationships([["rId1", "slideMaster", "../slideMasters/slideMaster1.xml"]]),
    );
    addXml(
        "ppt/theme/theme1.xml",
        theme(),
        "application/vnd.openxmlformats-officedocument.theme+xml",
    );
    addPart(
        "ppt/notesMasters/notesMaster1.xml",
        `<p:notesMaster ${NS}><p:cSld>${notesShapes("")}</p:cSld>
            <p:clrMap ${COLOR_MAP}/><p:notesStyle/>
        </p:notesMaster>`,
        "notesMaster",
    );
    addXml(
        "ppt/notesMasters/_rels/notesMaster1.xml.rels",
        relationships([["rId1", "theme", "../theme/theme1.xml"]]),
    );

    slides.forEach(({ image, text }, i) => {
        const n = i + 1;
        const extension = imageType(image);
        const imageName = `image${n}.${extension}`;

        imageTypes.add(extension);
        entries.push({ name: `ppt/media/${imageName}`, bytes: image });
        addPart(
            `ppt/slides/slide${n}.xml`,
            `<p:sld ${NS}><p:cSld>${shapeTree(`<p:pic>
                <p:nvPicPr><p:cNvPr id="2" name="Slide ${n}"/>
                    <p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/>
                </p:nvPicPr>
                <p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>
                <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${width}" cy="${height}"/></a:xfrm>
                    <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
                </p:spPr>
            </p:pic>`)}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`,
            "slide",
        );
        addXml(
            `ppt/slides/_rels/slide${n}.xml.rels`,
            relationships([
                ["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"],
                ["rId2", "image", `../media/${imageName}`],
                ["rId3", "notesSlide", `../notesSlides/notesSlide${n}.xml`],
            ]),
        );
        addPart(
            `ppt/notesSlides/notesSlide${n}.xml`,
            `<p:notes ${NS}><p:cSld>${notesShapes(text)}</p:cSld>
                <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
            </p:notes>`,
            "notesSlide",
        );
        addXml(
            `ppt/notesSlides/_rels/notesSlide${n}.xml.rels`,
            relationships([
                ["rId1", "notesMaster", "../notesMasters/notesMaster1.xml"],
                ["rId2", "slide", `../slides/slide${n}.xml`],
            ]),
        );
    });
    addXml(
        "[Content_Types].xml",
        `<Types xmlns="${CONTENT_TYPES}">
            <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
            <Default Extension="xml" ContentType="application/xml"/>
            ${[...imageTypes].map((extension) => `<Default Extension="${extension}" ContentType="image/${extension}"/>`).join("")}
            ${overrides.join("")}
        </Types>`,
    );

    return zip(entries);
}
