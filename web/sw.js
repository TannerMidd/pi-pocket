// Pi Pocket's service worker: it only shows push notifications (Pi finished, an approval, a chat message) and opens
// the right session when one is tapped. It does not cache anything: the app is edited live.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
	let data = {};
	try {
		data = event.data?.json() ?? {};
	} catch {
		data = { title: "Pi Pocket", body: event.data?.text() ?? "" };
	}
	event.waitUntil(
		self.registration.showNotification(data.title || "Pi Pocket", {
			body: data.body || "",
			tag: data.tag,
			renotify: Boolean(data.tag),
			icon: "/icon.svg",
			data: { url: data.url || "/" },
		}),
	);
});

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const url = new URL(event.notification.data?.url || "/", self.location.origin).href;
	event.waitUntil(
		(async () => {
			const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
			const open = windows.find((client) => new URL(client.url).origin === self.location.origin);
			if (open) {
				await open.focus();
				try {
					await open.navigate(url);
					return;
				} catch {
					// Not controlled by this worker yet: open a new window instead.
				}
			}
			await self.clients.openWindow(url);
		})(),
	);
});
