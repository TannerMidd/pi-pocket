// A fake sandbox provider for tests of the core (`sandbox.ts`): no VM, and gates, so nothing waits on time. Each hold is a
// promise that the test opens; a step that reached it says so, so a test knows the step is in flight.
import {
    READINESS_COMPONENTS,
    type SandboxOptions,
    type SandboxProvider,
    type SandboxTarget,
} from "../src/server/sandbox.ts";
import type { ConversationId } from "@earendil-works/pi-durable";
import { ExecutionError, FileError, type ExecutionEnv, ok } from "@earendil-works/pi-durable/env";
import type { OpenOptions } from "../src/server/app.ts";

/** A promise that settles when `open` is called, and one that settles when a step reaches `wait`. */
export function gate() {
    let open!: () => void;
    let reach!: () => void;
    const opened = new Promise<void>((resolve) => (open = resolve));
    const reached = new Promise<void>((resolve) => (reach = resolve));

    return {
        open,
        reached,
        wait: async () => {
            reach();
            await opened;
        },
    };
}

export type Gate = ReturnType<typeof gate>;

export class FakeProvider implements SandboxProvider {
    /** Roots whose VM was released, in order. */
    released: number[] = [];
    /** Targets whose environment was asked for. */
    targets: SandboxTarget[] = [];
    /** Commands the fake guest ran. */
    ran: string[] = [];
    /** Holds `release` until opened, when set. */
    holdRelease: Gate | undefined;
    failRelease: string | undefined;
    stricterNow = false;
    people = new Set<string>();
    /** `undefined`: everyone may choose. */
    mayChoose = () => true;
    jobs = undefined;
    browser = undefined;

    env(target: SandboxTarget): ExecutionEnv {
        this.targets.push(target);
        const ran = this.ran;

        return {
            id: "fake-guest",
            cwd: target.cwd,
            exec: (command: unknown) => {
                ran.push(String(command));

                return Promise.resolve(ok({ exitCode: 0 }));
            },
            readTextFile: () => Promise.resolve(ok("guest")),
            cleanup: () => Promise.resolve(),
        } as unknown as ExecutionEnv;
    }

    async release(root: ConversationId): Promise<void> {
        await this.holdRelease?.wait();

        if (this.failRelease !== undefined) {
            throw new Error(this.failRelease);
        }

        this.released.push(Number(root));
    }

    stricter(): boolean {
        return this.stricterNow;
    }
}

/** Open options that make every component present, and a trusted-places check that allows (unless `trusted` says why not). */
export function sandboxOptions(
    extra: Partial<SandboxOptions> & { trusted?: (folder: string) => string | undefined } = {},
): Partial<OpenOptions> {
    const { trusted, ...rest } = extra;

    return {
        sandbox: {
            platform: "linux",
            components: [...READINESS_COMPONENTS],
            trustedPlaces: { check: (folder) => Promise.resolve(trusted?.(folder)) },
            ...rest,
        },
    };
}

export { ExecutionError, FileError };
