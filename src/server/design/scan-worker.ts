// A worker of its own: a large or hostile project does not hold up the server, and the worker can be stopped.
import { parentPort, workerData } from "node:worker_threads";
import { type Rendered, scanTokens } from "./scan.ts";

const { root, rendered } = workerData as { root: string; rendered?: Rendered };

parentPort!.postMessage(scanTokens(root, rendered));
