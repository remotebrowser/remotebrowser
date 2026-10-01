import { consola } from 'consola/basic';
import { diag, DiagConsoleLogger, DiagLogLevel, trace } from '@opentelemetry/api';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import { LoggerProvider, BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto';
import { NodeTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';

const resolveHeaders = () => {
  const raw = process.env.OTEL_EXPORTER_OTLP_HEADERS;
  if (!raw) {
    return null;
  }
  const headers = {};
  for (const pair of raw.split(',')) {
    const separator = pair.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (!name || !value) {
      continue;
    }
    try {
      headers[name] = decodeURIComponent(value);
    } catch {
      headers[name] = value;
    }
  }
  return Object.keys(headers).length > 0 ? headers : null;
};

const resolveExporterOptions = (signal) => {
  const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (otlpEndpoint) {
    const base = otlpEndpoint.replace(/\/+$/, '').replace(/\/v1\/(traces|metrics|logs)$/, '');
    const headers = resolveHeaders();
    return headers ? { url: `${base}/v1/${signal}`, headers } : { url: `${base}/v1/${signal}` };
  }
  return null;
};

const resource = () =>
  resourceFromAttributes({
    'service.name': process.env.OTEL_SERVICE_NAME || 'remotebrowser',
    'deployment.environment.name': process.env.ENV || process.env.NODE_ENV || 'development'
  });

const FATAL = { number: SeverityNumber.FATAL, text: 'FATAL' };
const ERROR = { number: SeverityNumber.ERROR, text: 'ERROR' };
const WARN = { number: SeverityNumber.WARN, text: 'WARN' };
const INFO = { number: SeverityNumber.INFO, text: 'INFO' };
const DEBUG = { number: SeverityNumber.DEBUG, text: 'DEBUG' };
const TRACE = { number: SeverityNumber.TRACE, text: 'TRACE' };

const CONSOLA_TYPE_TO_SEVERITY = {
  fatal: FATAL,
  error: ERROR,
  fail: ERROR,
  warn: WARN,
  log: INFO,
  info: INFO,
  success: INFO,
  ready: INFO,
  start: INFO,
  box: INFO,
  debug: DEBUG,
  trace: TRACE,
  verbose: TRACE
};

const CONSOLA_LEVEL_TO_SEVERITY = { 0: ERROR, 1: WARN, 2: INFO, 3: INFO, 4: DEBUG, 5: TRACE };

const resolveSeverity = ({ type, level }) => CONSOLA_TYPE_TO_SEVERITY[type] || CONSOLA_LEVEL_TO_SEVERITY[level] || INFO;

const buildLogRecord = (logObj) => {
  const parts = [];
  const attributes = { 'log.tag': logObj.tag || 'consola' };
  if (logObj.message) {
    parts.push(logObj.message);
  }
  if (Array.isArray(logObj.args)) {
    for (const arg of logObj.args) {
      if (arg instanceof Error) {
        parts.push(arg.message);
      } else if (arg !== null && typeof arg === 'object') {
        Object.assign(attributes, arg);
      } else if (typeof arg === 'string') {
        parts.push(arg);
      } else {
        parts.push(String(arg));
      }
    }
  }
  return { message: parts.join(' '), attributes };
};

const otelLogLevel = process.env.OTEL_LOG_LEVEL && DiagLogLevel[process.env.OTEL_LOG_LEVEL.toUpperCase()];
if (otelLogLevel !== undefined) {
  diag.setLogger(new DiagConsoleLogger(), otelLogLevel);
}

const logsExporterOptions = resolveExporterOptions('logs');

let logsProvider = null;

if (logsExporterOptions) {
  consola.start(`Sending logs via OTLP to ${logsExporterOptions.url}`);
  const loggerProvider = new LoggerProvider({
    resource: resource(),
    processors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter(logsExporterOptions) })]
  });
  logs.setGlobalLoggerProvider(loggerProvider);
  logsProvider = loggerProvider;
  const logger = logs.getLogger('consola');

  consola.addReporter({
    log(logObj) {
      const { number: severityNumber, text: severityText } = resolveSeverity(logObj);
      const { message, attributes } = buildLogRecord(logObj);
      logger.emit({ severityNumber, severityText, body: message, attributes });
    }
  });
} else {
  consola.warn('OTEL_EXPORTER_OTLP_ENDPOINT not set - OTLP log export disabled');
}

const tracesExporterOptions = resolveExporterOptions('traces');

let tracesProvider = null;

if (tracesExporterOptions) {
  consola.start(`Sending traces via OTLP to ${tracesExporterOptions.url}`);
  tracesProvider = new NodeTracerProvider({
    resource: resource(),
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter(tracesExporterOptions))]
  });
  tracesProvider.register();
} else {
  consola.warn('OTEL_EXPORTER_OTLP_ENDPOINT not set - OTLP trace export disabled');
}

const tracer = trace.getTracer('http');

const shutdown = async () => {
  await Promise.allSettled([
    logsProvider ? logsProvider.shutdown() : Promise.resolve(),
    tracesProvider ? tracesProvider.shutdown() : Promise.resolve()
  ]);
};

export { buildLogRecord, resolveSeverity, resolveExporterOptions, resolveHeaders, resource, tracer, shutdown };
