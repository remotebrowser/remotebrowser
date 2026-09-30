# Instrumentation

The app exports logs and traces using [OpenTelemetry](https://opentelemetry.io) Protocol only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. Without it, the app runs normally and needs no extra setup.

For local testing, use [otel-gui](https://github.com/metafab/otel-gui). It is a lightweight OpenTelemetry trace viewer that needs no configuration.

If the OTLP backend needs authentication, set `OTEL_EXPORTER_OTLP_HEADERS`. This is a comma-separated list of `name=value` pairs. Percent-encode any value that contains special characters. Here is an example with a [Logfire](https://logfire.pydantic.dev) write token:

```
OTEL_EXPORTER_OTLP_ENDPOINT=https://logfire-api.pydantic.dev
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer <logfire-write-token>
```

To change the service name, set `OTEL_SERVICE_NAME` (default: `remotebrowser`).
