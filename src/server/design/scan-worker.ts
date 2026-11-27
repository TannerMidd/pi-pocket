// A worker of its own: a large or hostile project does not hold up the server, and the worker can be stopped.
import { parentPort, workerData } from "node:worker_threads";
import { type PlaceData, receivePlace } from "../hostfs.ts";
import { type Rendered, scanTokens } from "./scan.ts";

const { root, rendered } = workerData as { root: PlaceData; rendered?: Rendered };

parentPort!.postMessage(scanTokens(receivePlace(root), rendered));
