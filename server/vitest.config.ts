import { defineConfig } from "vitest/config";

// Retry tests wait on purpose (backoff and Retry-After), so the 5 s default is too tight.
export default defineConfig({ test: { testTimeout: 20_000 } });
