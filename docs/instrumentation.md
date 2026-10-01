# Instrumentation

## OpenTelemetry

The app exports logs and traces using [OpenTelemetry](https://opentelemetry.io) Protocol only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. Without it, the app runs normally and needs no extra setup.

For local testing, use [otel-gui](https://github.com/metafab/otel-gui). It is a lightweight OpenTelemetry trace viewer that needs no configuration.

If the OTLP backend needs authentication, set `OTEL_EXPORTER_OTLP_HEADERS`. This is a comma-separated list of `name=value` pairs. Percent-encode any value that contains special characters. Here is an example with a [Logfire](https://logfire.pydantic.dev) write token:

```
OTEL_EXPORTER_OTLP_ENDPOINT=https://logfire-api.pydantic.dev
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer <logfire-write-token>
```

To change the service name, set `OTEL_SERVICE_NAME` (default: `remotebrowser`).

## Client address

Behind a reverse proxy, the socket peer is the proxy, not the user. This applies to any proxy that sets [`X-Forwarded-For`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/X-Forwarded-For), such as [nginx](https://nginx.org), a cloud load balancer, or a platform router. Set `TRUSTED_PROXY_HOPS` to the number of proxies in front of the app, so that logs and traces record the real client address.

For example, a single proxy in front of the app needs `TRUSTED_PROXY_HOPS=1`. This is the case on [Dokku](https://dokku.com), which puts nginx in front of each app.

A [CDN](https://developer.mozilla.org/en-US/docs/Glossary/CDN) in front of that proxy adds one more hop, so the value becomes `2`. This works only if the inner proxy appends to `X-Forwarded-For` instead of replacing it.

A client can send any `X-Forwarded-For` header it wants ([IP spoofing via HTTP headers](https://community.owasp.org/pages/attacks/ip_spoofing_via_http_headers)), so the app does not simply take the leftmost entry. Each proxy appends the address it saw. The app walks back from the right through exactly `TRUSTED_PROXY_HOPS` entries, so any forged entries on the left are ignored. The app also ignores the header when the socket peer is a public address, because then the request did not come through your proxy. Do not set this value higher than the real number of proxies: each extra hop lets a client choose the address that gets logged.
