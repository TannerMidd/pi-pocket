import { type Literal, readLiteral } from "./scan-parse.ts";
import { addVar, type Category, type Facts, GENERIC } from "./scan-facts.ts";

// Taken from the packages `tailwindcss` 3.4 (`colors.js`) and 4 (`theme.css`), MIT license. Version 3 (hex) and version 4 (Oklch) differ for some colors, so both are kept.

const V4 =
    "red-50:97.1 0.013 17.38|red-100:93.6 0.032 17.717|red-200:88.5 0.062 18.334|red-300:80.8 0.114 19.571|red-400:70.4 0.191 22.216|red-500:63.7 0.237 25.331|red-600:57.7 0.245 27.325|red-700:50.5 0.213 27.518|red-800:44.4 0.177 26.899|red-900:39.6 0.141 25.723|red-950:25.8 0.092 26.042|orange-50:98 0.016 73.684|orange-100:95.4 0.038 75.164|orange-200:90.1 0.076 70.697|orange-300:83.7 0.128 66.29|orange-400:75 0.183 55.934|orange-500:70.5 0.213 47.604|orange-600:64.6 0.222 41.116|orange-700:55.3 0.195 38.402|orange-800:47 0.157 37.304|orange-900:40.8 0.123 38.172|orange-950:26.6 0.079 36.259|amber-50:98.7 0.022 95.277|amber-100:96.2 0.059 95.617|amber-200:92.4 0.12 95.746|amber-300:87.9 0.169 91.605|amber-400:82.8 0.189 84.429|amber-500:76.9 0.188 70.08|amber-600:66.6 0.179 58.318|amber-700:55.5 0.163 48.998|amber-800:47.3 0.137 46.201|amber-900:41.4 0.112 45.904|amber-950:27.9 0.077 45.635|yellow-50:98.7 0.026 102.212|yellow-100:97.3 0.071 103.193|yellow-200:94.5 0.129 101.54|yellow-300:90.5 0.182 98.111|yellow-400:85.2 0.199 91.936|yellow-500:79.5 0.184 86.047|yellow-600:68.1 0.162 75.834|yellow-700:55.4 0.135 66.442|yellow-800:47.6 0.114 61.907|yellow-900:42.1 0.095 57.708|yellow-950:28.6 0.066 53.813|lime-50:98.6 0.031 120.757|lime-100:96.7 0.067 122.328|lime-200:93.8 0.127 124.321|lime-300:89.7 0.196 126.665|lime-400:84.1 0.238 128.85|lime-500:76.8 0.233 130.85|lime-600:64.8 0.2 131.684|lime-700:53.2 0.157 131.589|lime-800:45.3 0.124 130.933|lime-900:40.5 0.101 131.063|lime-950:27.4 0.072 132.109|green-50:98.2 0.018 155.826|green-100:96.2 0.044 156.743|green-200:92.5 0.084 155.995|green-300:87.1 0.15 154.449|green-400:79.2 0.209 151.711|green-500:72.3 0.219 149.579|green-600:62.7 0.194 149.214|green-700:52.7 0.154 150.069|green-800:44.8 0.119 151.328|green-900:39.3 0.095 152.535|green-950:26.6 0.065 152.934|emerald-50:97.9 0.021 166.113|emerald-100:95 0.052 163.051|emerald-200:90.5 0.093 164.15|emerald-300:84.5 0.143 164.978|emerald-400:76.5 0.177 163.223|emerald-500:69.6 0.17 162.48|emerald-600:59.6 0.145 163.225|emerald-700:50.8 0.118 165.612|emerald-800:43.2 0.095 166.913|emerald-900:37.8 0.077 168.94|emerald-950:26.2 0.051 172.552|teal-50:98.4 0.014 180.72|teal-100:95.3 0.051 180.801|teal-200:91 0.096 180.426|teal-300:85.5 0.138 181.071|teal-400:77.7 0.152 181.912|teal-500:70.4 0.14 182.503|teal-600:60 0.118 184.704|teal-700:51.1 0.096 186.391|teal-800:43.7 0.078 188.216|teal-900:38.6 0.063 188.416|teal-950:27.7 0.046 192.524|cyan-50:98.4 0.019 200.873|cyan-100:95.6 0.045 203.388|cyan-200:91.7 0.08 205.041|cyan-300:86.5 0.127 207.078|cyan-400:78.9 0.154 211.53|cyan-500:71.5 0.143 215.221|cyan-600:60.9 0.126 221.723|cyan-700:52 0.105 223.128|cyan-800:45 0.085 224.283|cyan-900:39.8 0.07 227.392|cyan-950:30.2 0.056 229.695|sky-50:97.7 0.013 236.62|sky-100:95.1 0.026 236.824|sky-200:90.1 0.058 230.902|sky-300:82.8 0.111 230.318|sky-400:74.6 0.16 232.661|sky-500:68.5 0.169 237.323|sky-600:58.8 0.158 241.966|sky-700:50 0.134 242.749|sky-800:44.3 0.11 240.79|sky-900:39.1 0.09 240.876|sky-950:29.3 0.066 243.157|blue-50:97 0.014 254.604|blue-100:93.2 0.032 255.585|blue-200:88.2 0.059 254.128|blue-300:80.9 0.105 251.813|blue-400:70.7 0.165 254.624|blue-500:62.3 0.214 259.815|blue-600:54.6 0.245 262.881|blue-700:48.8 0.243 264.376|blue-800:42.4 0.199 265.638|blue-900:37.9 0.146 265.522|blue-950:28.2 0.091 267.935|indigo-50:96.2 0.018 272.314|indigo-100:93 0.034 272.788|indigo-200:87 0.065 274.039|indigo-300:78.5 0.115 274.713|indigo-400:67.3 0.182 276.935|indigo-500:58.5 0.233 277.117|indigo-600:51.1 0.262 276.966|indigo-700:45.7 0.24 277.023|indigo-800:39.8 0.195 277.366|indigo-900:35.9 0.144 278.697|indigo-950:25.7 0.09 281.288|violet-50:96.9 0.016 293.756|violet-100:94.3 0.029 294.588|violet-200:89.4 0.057 293.283|violet-300:81.1 0.111 293.571|violet-400:70.2 0.183 293.541|violet-500:60.6 0.25 292.717|violet-600:54.1 0.281 293.009|violet-700:49.1 0.27 292.581|violet-800:43.2 0.232 292.759|violet-900:38 0.189 293.745|violet-950:28.3 0.141 291.089|purple-50:97.7 0.014 308.299|purple-100:94.6 0.033 307.174|purple-200:90.2 0.063 306.703|purple-300:82.7 0.119 306.383|purple-400:71.4 0.203 305.504|purple-500:62.7 0.265 303.9|purple-600:55.8 0.288 302.321|purple-700:49.6 0.265 301.924|purple-800:43.8 0.218 303.724|purple-900:38.1 0.176 304.987|purple-950:29.1 0.149 302.717|fuchsia-50:97.7 0.017 320.058|fuchsia-100:95.2 0.037 318.852|fuchsia-200:90.3 0.076 319.62|fuchsia-300:83.3 0.145 321.434|fuchsia-400:74 0.238 322.16|fuchsia-500:66.7 0.295 322.15|fuchsia-600:59.1 0.293 322.896|fuchsia-700:51.8 0.253 323.949|fuchsia-800:45.2 0.211 324.591|fuchsia-900:40.1 0.17 325.612|fuchsia-950:29.3 0.136 325.661|pink-50:97.1 0.014 343.198|pink-100:94.8 0.028 342.258|pink-200:89.9 0.061 343.231|pink-300:82.3 0.12 346.018|pink-400:71.8 0.202 349.761|pink-500:65.6 0.241 354.308|pink-600:59.2 0.249 0.584|pink-700:52.5 0.223 3.958|pink-800:45.9 0.187 3.815|pink-900:40.8 0.153 2.432|pink-950:28.4 0.109 3.907|rose-50:96.9 0.015 12.422|rose-100:94.1 0.03 12.58|rose-200:89.2 0.058 10.001|rose-300:81 0.117 11.638|rose-400:71.2 0.194 13.428|rose-500:64.5 0.246 16.439|rose-600:58.6 0.253 17.585|rose-700:51.4 0.222 16.935|rose-800:45.5 0.188 13.697|rose-900:41 0.159 10.272|rose-950:27.1 0.105 12.094|slate-50:98.4 0.003 247.858|slate-100:96.8 0.007 247.896|slate-200:92.9 0.013 255.508|slate-300:86.9 0.022 252.894|slate-400:70.4 0.04 256.788|slate-500:55.4 0.046 257.417|slate-600:44.6 0.043 257.281|slate-700:37.2 0.044 257.287|slate-800:27.9 0.041 260.031|slate-900:20.8 0.042 265.755|slate-950:12.9 0.042 264.695|gray-50:98.5 0.002 247.839|gray-100:96.7 0.003 264.542|gray-200:92.8 0.006 264.531|gray-300:87.2 0.01 258.338|gray-400:70.7 0.022 261.325|gray-500:55.1 0.027 264.364|gray-600:44.6 0.03 256.802|gray-700:37.3 0.034 259.733|gray-800:27.8 0.033 256.848|gray-900:21 0.034 264.665|gray-950:13 0.028 261.692|zinc-100:96.7 0.001 286.375|zinc-200:92 0.004 286.32|zinc-300:87.1 0.006 286.286|zinc-400:70.5 0.015 286.067|zinc-500:55.2 0.016 285.938|zinc-600:44.2 0.017 285.786|zinc-700:37 0.013 285.805|zinc-800:27.4 0.006 286.033|zinc-900:21 0.006 285.885|zinc-950:14.1 0.005 285.823|stone-50:98.5 0.001 106.423|stone-100:97 0.001 106.424|stone-200:92.3 0.003 48.717|stone-300:86.9 0.005 56.366|stone-400:70.9 0.01 56.259|stone-500:55.3 0.013 58.071|stone-600:44.4 0.011 73.639|stone-700:37.4 0.01 67.558|stone-800:26.8 0.007 34.298|stone-900:21.6 0.006 56.043|stone-950:14.7 0.004 49.25|mauve-100:96 0.003 325.6|mauve-200:92.2 0.005 325.62|mauve-300:86.5 0.012 325.68|mauve-400:71.1 0.019 323.02|mauve-500:54.2 0.034 322.5|mauve-600:43.5 0.029 321.78|mauve-700:36.4 0.029 323.89|mauve-800:26.3 0.024 320.12|mauve-900:21.2 0.019 322.12|mauve-950:14.5 0.008 326|olive-50:98.8 0.003 106.5|olive-100:96.6 0.005 106.5|olive-200:93 0.007 106.5|olive-300:88 0.011 106.6|olive-400:73.7 0.021 106.9|olive-500:58 0.031 107.3|olive-600:46.6 0.025 107.3|olive-700:39.4 0.023 107.4|olive-800:28.6 0.016 107.4|olive-900:22.8 0.013 107.4|olive-950:15.3 0.006 107.1|mist-50:98.7 0.002 197.1|mist-100:96.3 0.002 197.1|mist-200:92.5 0.005 214.3|mist-300:87.2 0.007 219.6|mist-400:72.3 0.014 214.4|mist-500:56 0.021 213.5|mist-600:45 0.017 213.2|mist-700:37.8 0.015 216|mist-800:27.5 0.011 216.9|mist-900:21.8 0.008 223.9|mist-950:14.8 0.004 228.8|taupe-50:98.6 0.002 67.8|taupe-100:96 0.002 17.2|taupe-200:92.2 0.005 34.3|taupe-300:86.8 0.007 39.5|taupe-400:71.4 0.014 41.2|taupe-500:54.7 0.021 43.1|taupe-600:43.8 0.017 39.3|taupe-700:36.7 0.016 35.7|taupe-800:26.8 0.011 36.5|taupe-900:21.4 0.009 43.1|taupe-950:14.7 0.004 49.3";

const V3 =
    "slate-50:f8fafc|slate-100:f1f5f9|slate-200:e2e8f0|slate-300:cbd5e1|slate-400:94a3b8|slate-500:64748b|slate-600:475569|slate-700:334155|slate-800:1e293b|slate-900:0f172a|slate-950:020617|gray-50:f9fafb|gray-100:f3f4f6|gray-200:e5e7eb|gray-300:d1d5db|gray-400:9ca3af|gray-500:6b7280|gray-600:4b5563|gray-700:374151|gray-800:1f2937|gray-900:111827|gray-950:030712|zinc-50:fafafa|zinc-100:f4f4f5|zinc-200:e4e4e7|zinc-300:d4d4d8|zinc-400:a1a1aa|zinc-500:71717a|zinc-600:52525b|zinc-700:3f3f46|zinc-800:27272a|zinc-900:18181b|zinc-950:09090b|neutral-50:fafafa|neutral-100:f5f5f5|neutral-200:e5e5e5|neutral-300:d4d4d4|neutral-400:a3a3a3|neutral-500:737373|neutral-600:525252|neutral-700:404040|neutral-800:262626|neutral-900:171717|neutral-950:0a0a0a|stone-50:fafaf9|stone-100:f5f5f4|stone-200:e7e5e4|stone-300:d6d3d1|stone-400:a8a29e|stone-500:78716c|stone-600:57534e|stone-700:44403c|stone-800:292524|stone-900:1c1917|stone-950:0c0a09|red-50:fef2f2|red-100:fee2e2|red-200:fecaca|red-300:fca5a5|red-400:f87171|red-500:ef4444|red-600:dc2626|red-700:b91c1c|red-800:991b1b|red-900:7f1d1d|red-950:450a0a|orange-50:fff7ed|orange-100:ffedd5|orange-200:fed7aa|orange-300:fdba74|orange-400:fb923c|orange-500:f97316|orange-600:ea580c|orange-700:c2410c|orange-800:9a3412|orange-900:7c2d12|orange-950:431407|amber-50:fffbeb|amber-100:fef3c7|amber-200:fde68a|amber-300:fcd34d|amber-400:fbbf24|amber-500:f59e0b|amber-600:d97706|amber-700:b45309|amber-800:92400e|amber-900:78350f|amber-950:451a03|yellow-50:fefce8|yellow-100:fef9c3|yellow-200:fef08a|yellow-300:fde047|yellow-400:facc15|yellow-500:eab308|yellow-600:ca8a04|yellow-700:a16207|yellow-800:854d0e|yellow-900:713f12|yellow-950:422006|lime-50:f7fee7|lime-100:ecfccb|lime-200:d9f99d|lime-300:bef264|lime-400:a3e635|lime-500:84cc16|lime-600:65a30d|lime-700:4d7c0f|lime-800:3f6212|lime-900:365314|lime-950:1a2e05|green-50:f0fdf4|green-100:dcfce7|green-200:bbf7d0|green-300:86efac|green-400:4ade80|green-500:22c55e|green-600:16a34a|green-700:15803d|green-800:166534|green-900:14532d|green-950:052e16|emerald-50:ecfdf5|emerald-100:d1fae5|emerald-200:a7f3d0|emerald-300:6ee7b7|emerald-400:34d399|emerald-500:10b981|emerald-600:059669|emerald-700:047857|emerald-800:065f46|emerald-900:064e3b|emerald-950:022c22|teal-50:f0fdfa|teal-100:ccfbf1|teal-200:99f6e4|teal-300:5eead4|teal-400:2dd4bf|teal-500:14b8a6|teal-600:0d9488|teal-700:0f766e|teal-800:115e59|teal-900:134e4a|teal-950:042f2e|cyan-50:ecfeff|cyan-100:cffafe|cyan-200:a5f3fc|cyan-300:67e8f9|cyan-400:22d3ee|cyan-500:06b6d4|cyan-600:0891b2|cyan-700:0e7490|cyan-800:155e75|cyan-900:164e63|cyan-950:083344|sky-50:f0f9ff|sky-100:e0f2fe|sky-200:bae6fd|sky-300:7dd3fc|sky-400:38bdf8|sky-500:0ea5e9|sky-600:0284c7|sky-700:0369a1|sky-800:075985|sky-900:0c4a6e|sky-950:082f49|blue-50:eff6ff|blue-100:dbeafe|blue-200:bfdbfe|blue-300:93c5fd|blue-400:60a5fa|blue-500:3b82f6|blue-600:2563eb|blue-700:1d4ed8|blue-800:1e40af|blue-900:1e3a8a|blue-950:172554|indigo-50:eef2ff|indigo-100:e0e7ff|indigo-200:c7d2fe|indigo-300:a5b4fc|indigo-400:818cf8|indigo-500:6366f1|indigo-600:4f46e5|indigo-700:4338ca|indigo-800:3730a3|indigo-900:312e81|indigo-950:1e1b4b|violet-50:f5f3ff|violet-100:ede9fe|violet-200:ddd6fe|violet-300:c4b5fd|violet-400:a78bfa|violet-500:8b5cf6|violet-600:7c3aed|violet-700:6d28d9|violet-800:5b21b6|violet-900:4c1d95|violet-950:2e1065|purple-50:faf5ff|purple-100:f3e8ff|purple-200:e9d5ff|purple-300:d8b4fe|purple-400:c084fc|purple-500:a855f7|purple-600:9333ea|purple-700:7e22ce|purple-800:6b21a8|purple-900:581c87|purple-950:3b0764|fuchsia-50:fdf4ff|fuchsia-100:fae8ff|fuchsia-200:f5d0fe|fuchsia-300:f0abfc|fuchsia-400:e879f9|fuchsia-500:d946ef|fuchsia-600:c026d3|fuchsia-700:a21caf|fuchsia-800:86198f|fuchsia-900:701a75|fuchsia-950:4a044e|pink-50:fdf2f8|pink-100:fce7f3|pink-200:fbcfe8|pink-300:f9a8d4|pink-400:f472b6|pink-500:ec4899|pink-600:db2777|pink-700:be185d|pink-800:9d174d|pink-900:831843|pink-950:500724|rose-50:fff1f2|rose-100:ffe4e6|rose-200:fecdd3|rose-300:fda4af|rose-400:fb7185|rose-500:f43f5e|rose-600:e11d48|rose-700:be123c|rose-800:9f1239|rose-900:881337|rose-950:4c0519";

const table = (text: string, make: (value: string) => string) =>
    new Map<string, string>([
        ...text.split("|").map((entry): [string, string] => {
            const [name, value] = entry.split(":") as [string, string];

            return [name, make(value)];
        }),
        ["white", "#ffffff"],
        ["black", "#000000"],
    ]);

export const TAILWIND_4_COLORS: ReadonlyMap<string, string> = table(V4, (value) => {
    const [l, c, h] = value.split(" ") as [string, string, string];

    return `oklch(${l}% ${c} ${h})`;
});

export const TAILWIND_3_COLORS: ReadonlyMap<string, string> = table(V3, (value) => `#${value}`);

const THEME_KEYS: Record<string, Category> = {
    colors: "color",
    fontFamily: "font",
    fontSize: "text",
    fontWeight: "weight",
    lineHeight: "leading",
    letterSpacing: "tracking",
    spacing: "space",
    borderRadius: "radius",
    boxShadow: "shadow",
    screens: "breakpoint",
    transitionDuration: "duration",
    transitionTimingFunction: "ease",
};

const isRecord = (value: Literal | undefined): value is { [key: string]: Literal } =>
    typeof value === "object" && value !== null && !Array.isArray(value);

function leaves(
    node: Literal,
    path: string[],
    out: { path: string[]; value: string }[],
    category: Category,
): void {
    if (out.length >= 600 || path.length > 6) {
        return;
    }

    if (typeof node === "string" || typeof node === "number") {
        out.push({ path, value: String(node) });
    } else if (Array.isArray(node)) {
        const strings = node.filter((item): item is string => typeof item === "string");
        const quoted = (name: string) =>
            /^[\w-]+$/.test(name) || GENERIC.has(name) ? name : `"${name}"`;

        if (strings.length > 0) {
            out.push({
                path,
                value: category === "font" ? strings.map(quoted).join(", ") : strings[0]!,
            });
        }
    } else if (isRecord(node)) {
        for (const [key, child] of Object.entries(node)) {
            leaves(child, key === "DEFAULT" ? path : [...path, key], out, category);
        }
    }
}

// Read as literals: no import is followed and no code is run.
export function tailwindConfig(facts: Facts, file: string, text: string): void {
    const head = /(?<![\w$.])theme\s*:\s*(?=\{)/.exec(text);
    const theme = head === null ? undefined : readLiteral(text, head.index + head[0].length);

    if (!isRecord(theme)) {
        return;
    }

    const extend = isRecord(theme.extend) ? theme.extend : {};

    for (const [key, part] of [...Object.entries(theme), ...Object.entries(extend)]) {
        const category = THEME_KEYS[key];
        const found: { path: string[]; value: string }[] = [];

        if (category === undefined) {
            continue;
        }

        leaves(part, [], found, category);

        for (const leaf of found) {
            if (leaf.path.length === 0 && category !== "font") {
                continue;
            }

            const at = text.indexOf(leaf.value, head!.index);

            addVar(facts, {
                name: leaf.path.join("-") || key,
                value: leaf.value.slice(0, 400),
                scope: "default",
                kind: "js",
                file,
                hint: category,
                ...(at === -1 ? {} : { line: 1 + (text.slice(0, at).match(/\n/g)?.length ?? 0) }),
            });
        }
    }
}
