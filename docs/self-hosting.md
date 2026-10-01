# Self-Hosting Guide

This guide covers production deployments only. It does not apply to local development.

> **Note:** Do not create `.env.template`, `.env.example`, or similar files that summarize the settings below. These settings are too important for a short summary.

The table below lists the environment variables that the app uses in production:

| Env name                      | Required | Description                                        |
| ----------------------------- | -------- | -------------------------------------------------- |
| `BROWSERFLEET_URL`            | Yes      | Browser fleet origin                               |
| `DATABASE_SSL_MODE`           | No       | `disable` turns off TLS to Postgres                |
| `DATABASE_URL`                | Yes      | Postgres connection string                         |
| `ENV`                         | No       | Telemetry environment name (default: `NODE_ENV`)   |
| `MAX_PERSONAL_BROWSERS`       | No       | Max browsers per personal workspace (default: `3`) |
| `MAX_TEAM_BROWSERS`           | No       | Max browsers per team workspace (default: `10`)    |
| `NODE_ENV`                    | No       | `production` enables production mode               |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | No       | OTLP endpoint for logs and traces                  |
| `OTEL_EXPORTER_OTLP_HEADERS`  | No       | `name=value` pairs for OTLP authentication         |
| `OTEL_LOG_LEVEL`              | No       | OTel diagnostic log level, for example `debug`     |
| `OTEL_SERVICE_NAME`           | No       | Service name (default: `remotebrowser`)            |
| `PORT`                        | No       | Listen port (default: `3000`)                      |
| `PUBLIC_ORIGIN`               | Yes      | Public https origin for sign-in links              |
| `RESOURCE_HMAC_SECRET`        | Yes      | Secret for resource handles                        |
| `SECURE_COOKIES`              | No       | `true` marks cookies `Secure`                      |
| `SESSION_NOT_BEFORE`          | No       | Reject sessions issued before this Unix time (ms)  |
| `SESSION_SECRET`              | Yes      | Secret(s) for auth data                            |
| `SIGNIN_SENDER_EMAIL`         | Yes      | Sender address for sign-in emails                  |
| `SMTP_HOST`                   | Yes      | SMTP server hostname                               |
| `SMTP_PASSWORD`               | Yes      | SMTP password                                      |
| `SMTP_PORT`                   | No       | SMTP port (default: `587`)                         |
| `SMTP_USER`                   | Yes      | SMTP username                                      |
| `TRUSTED_PROXY_HOPS`          | No       | Reverse proxies in front of the app (default: `0`) |

See [Security](security.md), [Sign-in](sign-in.md), [Database](database.md), and [Instrumentation](instrumentation.md) for details.
