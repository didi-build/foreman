// Every test file starts with a clean git environment (D-416). Git hands its hooks variables
// such as GIT_INDEX_FILE, the full path of the index being committed, and the pre-commit hook
// runs the tests, so a test that runs git in a temporary folder would otherwise write into the
// commit being made. A session can also set GIT_CONFIG_* variables that change how git behaves.
// Removing every inherited GIT_* variable here covers each test that runs git, now and later;
// the older per-test helpers (test/bootstrap-fixture.ts) stay, and a test that needs a git
// variable sets it on its own child process. The same file is in Launchpad and its projects.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("GIT_")) delete process.env[key];
}
