// Test fixtures must never outlive the test run that started them. Workers are spawned detached
// (own process group) and some fixture modes never finish on their own; when a test was killed or
// cleaned up early they piled up to hundreds of orphans and loaded the machine for hours.
// Exit when the owning test process is gone, and in any case after a hard lifetime cap.
const ownerPid = Number(process.env.AGENTHUB_TEST_OWNER_PID || 0);
const maxLifetimeMs = Number(process.env.FAKE_MAX_LIFETIME_MS || 180_000);

if (ownerPid > 0) {
  setInterval(() => {
    try { process.kill(ownerPid, 0); } catch { process.exit(1); }
  }, 1000).unref();
}
setTimeout(() => process.exit(1), maxLifetimeMs).unref();
