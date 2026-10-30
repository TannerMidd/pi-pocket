/** `heic-convert` ships no types: it decodes a HEIC/HEIF photo and encodes its main image as JPEG or PNG. */
declare module "heic-convert" {
    export default function convert(options: {
        buffer: Uint8Array;
        format: "JPEG" | "PNG";
        quality?: number;
    }): Promise<Buffer>;
}
