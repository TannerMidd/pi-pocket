import { win32 } from "node:path";

/**
 * A Windows system program by its full path. The runner's PATH may not hold System32: Git Bash starts it with its own
 * (`/mingw64/bin:/usr/bin:…`), and the desktop app passes the person's login PATH on. A name alone then fails with
 * ENOENT, so System32's own programs are named by their place.
 */
export function windowsSystemProgram(
    name: "powershell.exe" | "where.exe" | "taskkill.exe",
): string {
    const system32 = win32.join(
        process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows",
        "System32",
    );

    return name === "powershell.exe"
        ? win32.join(system32, "WindowsPowerShell", "v1.0", name)
        : win32.join(system32, name);
}
