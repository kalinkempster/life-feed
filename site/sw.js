// Service worker — the daily notification, and nothing else.
//
// It deliberately does NOT cache the site. This is a reading room whose whole
// point is a fresh edition each morning; an offline cache would mean opening the
// app to yesterday, which is the one failure this project keeps designing against.
//
// The push that arrives carries NO payload. That is a choice, not an omission:
//
//   - a payload would have to be encrypted per subscription, which is real
//     cryptography to get wrong for no benefit here
//   - a payload is composed when the sender runs. This fetches when the phone is
//     woken, so the notification cannot describe an edition that has since been
//     republished
//   - payloads are capped at ~4KB; headlines are not
//
// So the sender only says "wake up", and the worker asks the site what to say.

const NOTIFY_URL = "/notify.json";
const TAG = "daily-edition";

self.addEventListener("install", (event) => {
  // Take over immediately rather than waiting for every tab to close — there is
  // nothing cached to invalidate, so there is nothing to be careful about.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

/** Build the notification text from today's edition. */
function compose(data) {
  const count = Number(data && data.count) || 0;

  if (!count) {
    return {
      title: "Life of K² — no new edition",
      body: "Nothing cleared the bar overnight. A thin day looks thin.",
    };
  }

  const timely = Number(data.timely) || 0;
  const topics = Array.isArray(data.topics) ? data.topics : [];

  // Headline line: source — title, a couple of them, whatever fits comfortably.
  const lines = (data.headlines || [])
    .slice(0, 3)
    .map((h) => (h.source ? `${h.source} — ${h.title}` : h.title));

  const spread = topics.length ? `\n${topics.join(" · ")}` : "";

  return {
    title: `Life of K² — ${plural(count, "new story", "new stories")}`,
    body: `${lines.join("\n")}${spread}` ||
      `${plural(count, "story", "stories")}, ${timely} timely`,
  };
}

self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let data = null;
      try {
        const res = await fetch(`${NOTIFY_URL}?t=${Date.now()}`, { cache: "no-store" });
        if (res.ok) data = await res.json();
      } catch {
        /* offline or the file is missing — fall through to the generic notice */
      }

      // A push MUST produce a visible notification: every browser requires it under
      // userVisibleOnly, and silently swallowing one can cost the subscription.
      const { title, body } = data
        ? compose(data)
        : {
            title: "Life of K²",
            body: "Today's edition is ready.",
          };

      await self.registration.showNotification(title, {
        body,
        tag: TAG,               // replaces yesterday's rather than stacking
        renotify: true,
        icon: "/icon-192.png",
        badge: "/icon-192.png",
        data: { url: "/" },
      });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const url = new URL((event.notification.data || {}).url || "/", self.location.origin).href;
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });

      // Prefer an already-open window; opening a second copy of a reading room is
      // never what you wanted.
      for (const client of clients) {
        if (client.url.startsWith(self.location.origin) && "focus" in client) {
          await client.navigate(url).catch(() => {});
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })(),
  );
});

// If the push service rotates a subscription out from under us, re-subscribe with
// the same key and tell the server, or the notifications simply stop one day with
// nothing to show for it.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const res = await fetch("/push-key.json", { cache: "no-store" });
        const { publicKey } = await res.json();
        const sub = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: publicKey,
        });
        await fetch("/api/subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ subscription: sub }),
        });
      } catch {
        /* nothing useful to do here; the toggle in the footer re-establishes it */
      }
    })(),
  );
});
