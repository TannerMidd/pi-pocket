// A worker of its own: a large or broken photo does not hold up the server, and the worker can be stopped.
import { parentPort, workerData } from "node:worker_threads";
import convert from "heic-convert";

try {
    const jpeg = await convert({ buffer: workerData.bytes, format: "JPEG", quality: 0.92 });

    parentPort!.postMessage({ jpeg: new Uint8Array(jpeg) });
} catch (error) {
    parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) });
}
