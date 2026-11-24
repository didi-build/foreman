// The browser canary's service worker (ADR 0119 slice 5b). The browser host blocks service
// workers, so this never runs; if it did, it would reach the canary. Synthetic only.
const port = new URLSearchParams(self.location.search).get("canary");
self.addEventListener("install", () => {
  fetch(`http://127.0.0.1:${port}/service-worker`, { mode: "no-cors" }).catch(() => {});
});
