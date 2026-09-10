# Code Obfuscation, Framework Protection & Spaghettification Engine

This document is part of the core documentation for `@wpdev/standalone-build` and the code protection engine.

The master comprehensive technical context and handoff document is located at:
👉 **[`packages/standalone-build/OBFUSCATION_AND_SPAGHETTIFICATION_CONTEXT.md`](../packages/standalone-build/OBFUSCATION_AND_SPAGHETTIFICATION_CONTEXT.md)**

### Quick Overview

- **Core Mission:** Converting clean modular source code into non-reusable, tightly coupled "spaghetti code" artifacts for commercial client handover, while guaranteeing zero runtime regressions on WordPress and WooCommerce.
- **The Three Plans:**
  - **Plan 1:** De-modularization, Class Inlining & Spaghetti Coupling (eradicating the `WPDev` namespace and abstract inheritance).
  - **Plan 2:** Hybrid Protection & Multi-Factor DRM Licensing (Domain + ABSPATH + DB prefix + Ed25519 signature + Poison Pill integrity checks).
  - **Plan 3 (Profile S):** Native AST Obfuscation (`token_get_all()`), Rector PHP 7.4 downgrade, symbol mangling, 100% DocBlock stripping, and whitespace compaction.
- **Master Build Command:**
  ```bash
  node packages/standalone-build/build-all-standalone-plugins.mjs --obfuscate --deploy --jobs=4
  ```

For complete architectural details, preservation contracts, test suites, and operational guidelines, please see the [Master Context Document](../packages/standalone-build/OBFUSCATION_AND_SPAGHETTIFICATION_CONTEXT.md).
