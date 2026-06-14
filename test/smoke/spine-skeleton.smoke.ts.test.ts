// Auto-discovery shim. The test content lives in spine-skeleton.smoke.ts (the named deliverable).
// This file exists so Bun can discover the smoke test automatically via `bun test ./src ./test`
// and so `bun test test/smoke/spine-skeleton.smoke.ts` (substring filter) works on the shim name.
import "./spine-skeleton.smoke.ts";
