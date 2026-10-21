# Events

An event is a message from a module on the server to its browser module in the tabs. Use events to keep a page live, for example to show a new value when it changes.

## Send an event

On the server, `web.send(event, data, { to })` sends `data` as JSON. The name of the event has letters, digits, `.`, `_`, `:`, and `-`. Both have [limits](reference/limits.md#events). The event goes:

- without `to`, to the tabs of each person that the browser module's `access` lets in;
- with `to`, only to the tabs of the person whose id is `to`.

In the browser, `pocket.on(event, run)` gets it. It returns a function that stops it.

```typescript
// On the server: each minute, the new load.
const timer = setInterval(() => web.send("load", { load: os.loadavg() }), 60_000);

web.onDispose(() => clearInterval(timer));
```

```javascript
// In the browser module: show it.
const stop = pocket.on("load", ({ load }) => setLoad(load));
```

## When events get lost

- A tab whose browser module has not set up yet does not get the event.
- Send only after the module loaded: from a route, a timer, or a watcher. Events sent while the module loads go nowhere.
- Send only from a module that has a browser module. The events of a module without one go nowhere.
- A version that was replaced, or turned off, sends nothing.
- The app does not keep events for a page that was closed. A page that opens gets the current state first, and then listens. [examples/server-status.js](../examples/server-status.js) does this.

## Limits

A version of a module can send a limited number of events, and of bytes, in each second ([limits](reference/limits.md#events)). Pi Pocket drops the rest of that second's events. Send what changed, or a summary, not each tick.

Pi Pocket cuts off a tab that is far behind, and the tab connects again with a new view. It does not keep the events for it. It cuts off ([limits](reference/limits.md#events)):

- a tab that is behind and takes nothing for some time: it does not read its stream, or it polls and acknowledges nothing;
- any tab that is very far behind.

Below the second limit, Pi Pocket does not cut off a tab that continues to take events. So a slow phone gets all of them.

## Errors

`web.send` never throws: modules call it mostly from timers, where a throw would stop the server. An event that it cannot send goes to the server's log, one time for each kind of mistake in a version.
