// Pi Pocket site: copy buttons and the install tabs. The page works without this script.

function commandText(element) {
    // Copy commands only: drop prompts and comments, and keep one command per line.
    const clone = element.cloneNode(true);

    for (const node of clone.querySelectorAll(".p, .c")) {
        node.remove();
    }

    return clone.textContent
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .join("\n");
}

async function copy(button, text) {
    try {
        await navigator.clipboard.writeText(text);
        button.textContent = "Copied";
        button.classList.add("done");
    } catch {
        button.textContent = "Press Ctrl+C";
    }

    setTimeout(() => {
        button.textContent = "Copy";
        button.classList.remove("done");
    }, 1600);
}

for (const button of document.querySelectorAll("[data-copy]")) {
    button.addEventListener("click", () =>
        copy(button, commandText(document.querySelector(button.dataset.copy))),
    );
}

const tabs = [...document.querySelectorAll('[role="tab"]')];

function select(tab) {
    for (const other of tabs) {
        const on = other === tab;

        other.setAttribute("aria-selected", String(on));
        other.tabIndex = on ? 0 : -1;
        document.getElementById(other.getAttribute("aria-controls")).hidden = !on;
    }
}

for (const [index, tab] of tabs.entries()) {
    tab.addEventListener("click", () => select(tab));
    tab.addEventListener("keydown", (event) => {
        const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;

        if (!step) {
            return;
        }

        const next = tabs[(index + step + tabs.length) % tabs.length];

        select(next);
        next.focus();
    });
}

const activeCopy = document.querySelector("[data-copy-active]");

activeCopy?.addEventListener("click", () => {
    const panel = document.querySelector('[role="tabpanel"]:not([hidden])');

    if (panel) {
        copy(activeCopy, commandText(panel));
    }
});
