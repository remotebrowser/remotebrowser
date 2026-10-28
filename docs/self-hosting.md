# Self-Hosting Guide

This guide covers production deployments only. It does not apply to local development.

> **Note:** Do not create `.env.template`, `.env.example`, or similar files that summarize the settings below. These settings are too important for a short summary.

The table below lists the environment variables that the app uses in production:

| Env name                      | Required | Description                                                 |
| ----------------------------- | -------- | ----------------------------------------------------------- |
| `DATABASE_SSL_MODE`           | No       | `disable` turns off TLS to Postgres                         |
| `DATABASE_URL`                | Yes      | Postgres connection string                                  |
| `ENV`                         | No       | Telemetry environment name (default: `NODE_ENV`)            |
| `LLM_API_BASE_URL`            | No       | OpenAI-compatible LLM API, e.g. `https://api.openai.com/v1` |
| `LLM_API_KEY`                 | No       | API key for the LLM service                                 |
| `LLM_CHAT_MODEL`              | No       | LLM model name, e.g. `gpt-5-nano`                           |
| `NODE_ENV`                    | No       | `production` enables production mode                        |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | No       | OTLP endpoint for logs and traces                           |
| `OTEL_EXPORTER_OTLP_HEADERS`  | No       | `name=value` pairs for OTLP authentication                  |
| `OTEL_LOG_LEVEL`              | No       | OTel diagnostic log level, for example `debug`              |
| `OTEL_SERVICE_NAME`           | No       | Service name (default: `remotebrowser`)                     |
| `PORT`                        | No       | Listen port (default: `3000`)                               |
| `PUBLIC_ORIGIN`               | Yes      | Public https origin for sign-in links                       |
| `RESOURCE_HMAC_SECRET`        | Yes      | Secret for resource handles                                 |
| `SECURE_COOKIES`              | No       | `true` marks cookies `Secure`                               |
| `SESSION_NOT_BEFORE`          | No       | Reject sessions issued before this Unix time (ms)           |
| `SESSION_SECRET`              | Yes      | Secret(s) for auth data                                     |
| `SIGNIN_SENDER_EMAIL`         | Yes      | Sender address for sign-in emails                           |
| `SMTP_HOST`                   | Yes      | SMTP server hostname                                        |
| `SMTP_PASSWORD`               | Yes      | SMTP password                                               |
| `SMTP_PORT`                   | No       | SMTP port (default: `587`)                                  |
| `SMTP_USER`                   | Yes      | SMTP username                                               |
| `TRUSTED_PROXY_HOPS`          | No       | Reverse proxies in front of the app (default: `0`)          |
| `VM_CPUS`                     | No       | Virtual CPUs per browser VM (default: `2`)                  |
| `VM_DATA_DIR`                 | No       | VM images, snapshot, and VMs (default: `.data/vm`)          |
| `VM_MEMORY`                   | No       | Memory per browser VM (default: `2G`)                       |

See [Controls](controls.md), [Sign-in](sign-in.md), [Sandboxing](sandboxing.md), [Database](database.md), [Instrumentation](instrumentation.md), and [Harness](harness.md) for details.

## VM image

In the container, the server can build the VM image only through the host's Docker socket. [Getting Started](getting-started.md) gives the server the socket, for a quick try. Do not do this in production: the socket gives full control of the host, and the server runs untrusted pages. Instead, build the VM image and save its snapshot in a separate, short-lived container first:

```bash
docker run --rm -it \
  --security-opt label=disable \
  --user "$(id -u):$(id -g)" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  --group-add "$(stat -c '%g' /var/run/docker.sock)" \
  --device /dev/kvm \
  --group-add "$(stat -c '%g' /dev/kvm)" \
  -v "$PWD/.data/vm:/app/.data/vm" \
  ghcr.io/remotebrowser/remotebrowser vm/build-image.sh
```

Then start the server without the socket. Give it the same KVM access, user, and VM directory as the build, so it finds the image and the snapshot.

Run the build again after you pull a newer `ghcr.io/remotebrowser/remotebrowser`, in case its VM image changed. Without the socket, the server cannot build a new image by itself.
