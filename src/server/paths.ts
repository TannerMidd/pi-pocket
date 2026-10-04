/** Paths as people write them (`~/project`) and as activity lines show them. */
import { homedir } from "node:os";
import { join, sep } from "node:path";

/** `~` and `~/x` to absolute paths; anything else unchanged. */
export function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

/** `~/x` for paths under home. */
export function homePath(path: string): string {
	const home = homedir();
	return path === home || path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}
