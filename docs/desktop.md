# Desktop apps

A desktop app can show Pi Pocket in a window of its own: an Electron or Tauri wrapper, for example, with a tray icon, native notifications, and a menu of its own. [Pi Pocket GUI](https://github.com/vitalNohj/pi-pocket-gui) is one. Pi Pocket stays a web app on its server; the desktop app loads the server's address, and the person signs in there as in a browser.

A browser tab cannot do some things that such an app can, and Web Push does not reach a page in Electron. The **host bridge** joins the two: the app puts `window.pocketHost` in the page, and Pi Pocket uses what it offers. In a browser there is no bridge, and nothing changes.

## Finding Pi Pocket

`GET /api/pocket/info` answers without a sign-in:

```json
{ "name": "pi-pocket", "bridge": 1 }
```

`bridge` is the version of the host bridge that this server's web app speaks. The answer never has Pi Pocket's version. A server older than the bridge answers 401 there; its web app manifest (`/manifest.webmanifest`) still has `"name": "Pi Pocket"`.

## The bridge

The app's preload script puts one object in the top page of the server's origin, and nowhere else: never in a frame (artifacts run in frames), never on another origin.

```js
window.pocketHost = {
    kind: "pi-pocket-gui", // which app; for logs only
    apiVersion: 1,
    capabilities: ["menu", "badge", "notify", "visibility", "pinned", "open"],

    menuItems(), // [{ id, label, hint? }]: items for the app menu's Desktop group
    invoke(id), // one of them was chosen; false when it could not be done
    setBadge(count), // sessions that need you, as the home-screen icon counts them
    notify(message), // a notification for the app to show (below)
    visible(), // whether the app's window shows: false while hidden in a tray or minimized
    setPinned(list), // [{ id, title, state, label, url }]: the pinned sessions, in order
    subscribe(listener), // the app's events (below)
};
```

`web/host.js` reads it: `host`, `hostCan(capability)`, and `callHost(name, …)`, which catches what the app throws. `web/desktop.js` does the rest. Pi Pocket uses only the capabilities the app names, and ignores ones it does not know. A newer bridge keeps version 1's calls.

### Capabilities

| Capability   | What Pi Pocket does                                                                                                                                                                                                                                                                                                                          |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `menu`       | Shows `menuItems()` in a **Desktop** group at the top of the menu's App part. Choosing one calls `invoke(id)`. Pi Pocket GUI offers **Server settings…**.                                                                                                                                                                                    |
| `badge`      | Calls `setBadge(count)` instead of the Badging API whenever the count changes.                                                                                                                                                                                                                                                               |
| `notify`     | Opens its event stream with `host=notify`. The server then sends this connection every notification it would push to the person (`desktop-notify`), and the page passes each to `notify(message)`.                                                                                                                                           |
| `visibility` | Reads `visible()` with the page's own visibility: the page counts as hidden while either says so. It tells the server (`POST /api/visibility`), so the server knows the person is away and lets notifications through, and seen marks and peek tiles wait as they do in a hidden tab.                                                        |
| `pinned`     | Calls `setPinned(list)` when a pinned session's title or state changes, for a tray menu. `state` is the square's shape from `sessionMark`: `waiting`, `limited`, `working`, `failed`, `fresh` (finished, not read), or `seen`. The session list's theme states `done` and `idle` do not change these bridge names. `label` says it in words. |
| `open`       | Opens what the app asks for (an `open` event), also without `notify`.                                                                                                                                                                                                                                                                        |

A page in an Electron window keeps running at full speed while the window hides in the tray, so `document.visibilityState` stays `visible` there. That is why `visible()` exists: without it, the server would think the person is looking, and hold every notification back.

### Notifications

The server decides as for Web Push (`alerts.ts`): who can see the session, the kinds each person turned on in Menu → Notifications, and whether they are looking at it. Then it sends the message through Web Push to their subscribed devices, and to each of their desktop apps' connections (`PocketApp.notifyDesktops`). An app that is not running gets nothing: nothing waits for it.

```js
{
    title: "Pi needs approval · Deploy",
    body: "bash: npm run deploy", // cut at 400 characters, as for Web Push
    url: "/s/12", // what a click opens: a session, PiP ("/?pip=1"), or "/"
    tag: "approval-…", // one notification per tag: a newer one replaces it
    urgency: "high", // "normal", or "high" for approvals and questions
    approval: { // approvals only
        id: "…",
        allow: true, // Web Push's rule: the person may allow it, and the whole call fits on one short line
        may: true, // the person may allow it at all
        call: "bash: npm run deploy", // the whole call, never cut
    },
}
```

The app chooses how much of an approval to show and whether to offer **Allow**, from `may`, `allow`, and `call`. It always offers **Deny**. The server checks again, when the answer comes, that the person may give it.

### The app's events

`subscribe(listener)` takes one function. The app calls it with:

- `{ type: "visibility" }`: its window was shown or hidden. The page reads `visible()` again.
- `{ type: "open", url }`: open this, such as a notification or a tray item that was clicked. Only addresses of the server's own origin open.
- `{ type: "approve", id, allow }`: the person answered an approval in a notification. The page answers it with its own sign-in.

## The window's buttons

An app that hides its title bar, and shows Pi Pocket up to its window's top edge with the window's own buttons over it (close, minimize, zoom), tells the page where they are through the web's standard for it, the Window Controls Overlay (`navigator.windowControlsOverlay`). An installed web app with `"display_override": ["window-controls-overlay"]` does the same. The bridge is not needed for it.

`web/window-controls.js` makes room only under the buttons, and only as much as they take; the rest of the layout keeps its whole height:

- A bar under them (the session tabs, the conversation's top bar, a panel's, a viewer's) keeps what it holds beside them, and the window can be dragged by it.
- A window without one (the sidebar on wide screens, an extension's page) starts below them. Tiled, its margin moves it, so the tiles' gap stays above it.
- A strip beside the buttons, as wide as the windows that moved down, moves the window too. What floats over the app (sheets, the launcher, viewers, PiP) takes clicks there.

On `<html>`, `data-window-controls` is `left` (macOS), `right` (Windows, Linux), or `none`, and `--controls-h` is how far down the buttons reach. What makes room has `data-under-controls`, `bar` or `push`, and `--controls-room`. The page sets `data-window-controls` before its first paint, so an app can tell that it makes its own room. For a page without it (an older Pi Pocket, a sign-in page), Pi Pocket GUI instead sets a top safe-area inset as tall as the buttons, which Pi Pocket's bars have long kept clear of on phones.

## Security

The bridge is only as safe as the app that offers it. An app must:

- put it only in the top frame of the server's origin, and take it away when that frame goes elsewhere;
- check, in its main process, the frame and origin of every call that comes from the page;
- give the page no Node.js, and keep its sandbox and context isolation on.

Pi Pocket gives the bridge nothing that the page could not do over the API itself: the notifications are the person's own, and an approval's answer goes through the same route and checks as a tap in the app.
