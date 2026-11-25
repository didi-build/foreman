// The browser canary's dedicated worker (ADR 0119 slice 5b): a worker's own requests and
// WebSocket, which no page script wraps, must not reach the canary either. Synthetic only.
const port = new URLSearchParams(self.location.search).get("canary");
const settle = (work) =>
  Promise.race([
    Promise.resolve()
      .then(work)
      .catch(() => {}),
    new Promise((done) => setTimeout(done, 1500)),
  ]);
(async () => {
  await settle(() =>
    fetch(`http://127.0.0.1:${port}/worker-fetch`, { mode: "no-cors" }),
  );
  await settle(
    () =>
      new Promise((done) => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}/worker-ws`);
        socket.onopen = socket.onerror = socket.onclose = done;
      }),
  );
  self.postMessage("done");
})();
