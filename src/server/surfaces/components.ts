/**
 * Components that extension modules add to surfaces (`web.surfaceComponent`, docs/design/surfaces.md section 7). The
 * server half: a type named `x.<module>.<Name>`, a pi-schema for its props, an optional schema for the one value it
 * binds, and a `text` function for the plain forms. Its browser half (`pocket.surfaceComponent`) draws it for people
 * whose browser loads the module; a card never carries code. The registry lives with the extension web parts
 * (`extension-web.ts`), which the app hands to `setComponentSource`.
 */
import type { JsonValue } from "@earendil-works/chord/json";
import { compile, type JsonSchema, type Validator } from "@earendil-works/pi-schema";

/** What a module gives `web.surfaceComponent`. */
export interface SurfaceComponentSpec {
    /** `x.<module>.<Name>`: this module's name, then a name of letters and digits. */
    type: string;
    /** A pi-schema for the component's props (the keys beside `type`, `bind`, and `who`). */
    props: object;
    /** A pi-schema for the one value it binds (`bind: "/path"`); without it the component binds nothing. */
    bind?: object;
    /** Its text for the transcript, an export, a chat, and browsers without its module. Plain text, up to 500 characters. */
    text(props: Record<string, JsonValue>, data: Record<string, JsonValue>): string;
}

export type RegisteredComponent = {
    module: string;
    type: string;
    props: Validator;
    bind?: Validator;
    text: SurfaceComponentSpec["text"];
};

const NAME = /^[A-Za-z][A-Za-z0-9]{0,39}$/;
const NO_COMPONENTS: ReadonlyMap<string, RegisteredComponent> = new Map();
let source: () => ReadonlyMap<string, RegisteredComponent> = () => NO_COMPONENTS;

/** Where the registered components are read from: the extension web parts, set by the app. */
export function setComponentSource(
    read: () => ReadonlyMap<string, RegisteredComponent>,
): () => void {
    source = read;

    return () => {
        if (source === read) {
            source = () => NO_COMPONENTS;
        }
    };
}

/** The component registered for a type by a module that is on, or undefined. */
export function extensionComponent(type: string): RegisteredComponent | undefined {
    return type.startsWith("x.") ? source().get(type) : undefined;
}

/** A module's spec, checked: the type is its own, the schemas compile, `text` is a function. Throws a message for the module's author. */
export function checkComponentSpec(
    module: string,
    spec: SurfaceComponentSpec,
): RegisteredComponent {
    const where = "web.surfaceComponent";

    if (typeof spec !== "object" || spec === null) {
        throw new Error(`${where}: give it { type, props, text }`);
    }

    const prefix = `x.${module}.`;

    if (
        typeof spec.type !== "string" ||
        !spec.type.startsWith(prefix) ||
        !NAME.test(spec.type.slice(prefix.length))
    ) {
        throw new Error(
            `${where}: type is ${prefix}<Name>: this module's name, then letters and digits`,
        );
    }

    if (typeof spec.text !== "function") {
        throw new Error(
            `${where} ${spec.type}: text(props, data) gives the plain text of the component`,
        );
    }

    try {
        return {
            module,
            type: spec.type,
            props: compile(spec.props as JsonSchema),
            ...(spec.bind === undefined ? {} : { bind: compile(spec.bind as JsonSchema) }),
            text: spec.text,
        };
    } catch (error) {
        throw new Error(
            `${where} ${spec.type}: props and bind are pi-schema schemas: ${(error as Error).message}`,
        );
    }
}

/** The text of an extension's component, safely: its own function may throw or return anything. */
export function componentText(
    registered: RegisteredComponent,
    props: Record<string, JsonValue>,
    data: Record<string, JsonValue>,
): string | undefined {
    try {
        const text = registered.text(
            JSON.parse(JSON.stringify(props)) as Record<string, JsonValue>,
            JSON.parse(JSON.stringify(data)) as Record<string, JsonValue>,
        );

        return typeof text === "string"
            ? text
                  .replace(
                      /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g,
                      "",
                  )
                  .slice(0, 500)
            : undefined;
    } catch {
        return undefined;
    }
}

/** The props of a stored component: everything but its type, its binding, and its `who`. */
export function propsOf(component: Record<string, JsonValue>): Record<string, JsonValue> {
    const { type: _type, bind: _bind, who: _who, ...props } = component;

    return props;
}
