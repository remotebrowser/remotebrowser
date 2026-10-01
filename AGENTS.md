# AGENTS Instructions

This file provides guidance when working with code in this repository.

## Overview

This project is built with [Hono](https://hono.dev) and plain Node.js. It uses ESM only, with no TypeScript and no bundler. By default, it listens on `127.0.0.1:3000`.

## Commands

```bash
npm install              # install dependencies
npm start                # run the server
npm test                 # run unit tests
npm run format           # check/fix formatting with oxfmt
npm run typecheck        # oxlint --type-aware
npm run test:e2e         # run Playwright e2e tests, auto-starts the server
uv run zensical serve    # preview the Zensical-based docs
```

There is no build step. The app runs directly from source, using Node.js's native ESM support.

## Code style

Keep comments, commit messages, and notes brief. Explain _why_ the code is needed, not _what_ it does. Use clear, simple, and natural English that is easy for non-native speakers to understand.

## Architecture

### Config & secrets

Config is built once from `process.env`, at import time. The build function is also exported separately, for testing. In production, if a required security env var is missing or invalid, the app fails fast.

See the docs/self-hosting.md for the important secrets. Do not create `.env.example` or `.env.template` files that summarize these settings. The self-hosting guide deliberately avoids an oversimplified summary, because the security stakes are high.

### Tests

Unit tests live next to the source files and use the `*_tests.js` suffix. They run on Node.js's built-in test runner (no extra framework) and are excluded from type-aware linting.

Config assertions that apply only in production mode use a separate `*_production_tests.js` suffix, to keep them apart from the general unit tests.

E2E tests use Playwright and run against a real, running server. Playwright starts the server itself and waits for the health-check endpoint before running the tests.

### Views

HTML is server-rendered with [Eta](https://eta.js.org), using a shared layout and partials.

Each route renders a named template with its data and returns the result as HTML.
