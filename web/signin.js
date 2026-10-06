// The sign-in screen, for a browser that is not signed in.

import { useState } from "preact/hooks";
import { html } from "./ui.js";

export function SignIn() {
    const [value, setValue] = useState("");

    const go = () => {
        const text = value.trim();

        if (!text) {
            return;
        }

        try {
            const url = new URL(text, location.origin);

            if (url.pathname.startsWith("/join/") || url.searchParams.has("token")) {
                location.href = `${url.pathname}${url.search}`;

                return;
            }
        } catch {
            // not a URL
        }

        // Invite codes are ten lowercase letters and digits, and phones capitalize the first letter typed. Tokens are longer.
        // The invite sheet shows a code in two groups, so spaces typed or copied between them are dropped.
        const code = text.toLowerCase().replace(/\s+/g, "");

        location.href = /^[a-z0-9]{10}$/.test(code)
            ? `/join/${code}`
            : `/login?token=${encodeURIComponent(text)}`;
    };

    return html`<div class="signin">
        <div class="pi big">π</div>
        <h1>Pi Pocket</h1>
        <p class="muted">
            Open the sign-in link Pi Pocket printed when it started, or an invite from a signed-in device. You can also paste the link, the token, or an invite code here.
        </p>
        <div class="row">
            <input
                value=${value}
                placeholder="Link, token, or invite code"
                autocapitalize="none"
                autocorrect="off"
                autocomplete="off"
                spellcheck=${false}
                onInput=${(event) => setValue(event.currentTarget.value)}
                onKeyDown=${(event) => event.key === "Enter" && go()}
            />
            <button class="button primary" onClick=${go}>Sign in</button>
        </div>
    </div>`;
}
