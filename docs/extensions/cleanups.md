# Cleanups

A cleanup stops what a version of your module started, when that version goes. Pi Pocket starts the module again at each reload, so without a cleanup, the old version's timers continue to run.

## On the server

`web.onDispose(run)` runs `run` when this version of the module goes:

- an edit replaces it,
- the owner turns it off, or
- the server stops.

```typescript
const timer = setInterval(check, 60_000);

web.onDispose(() => clearInterval(timer));
```

Stop timers and close connections there.

- A cleanup that the module registers after it loaded, for example from a timer, also runs.
- A cleanup that the module registers after the version went runs at once.
- `run` can return a promise. When the server stops, it waits a short time for these promises ([limits](reference/limits.md#cleanups)). This includes the cleanups of versions that still go (replaced or turned off a moment before), and of a version that still loads.

## In the browser

`pocket.onDispose(run)` does the same in the browser. The app does not wait for a browser cleanup: do at once what must finish.

## The order

The new version starts before the cleanups of the old version run. So an edit that fails leaves the old version complete.

This means that the module cannot take something that only one version can hold, such as a port or a lock, while it loads. Take it at its first use, or try again a moment later.
