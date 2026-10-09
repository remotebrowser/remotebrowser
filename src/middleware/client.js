import { getConnInfo } from '@hono/node-server/conninfo';
import { consola } from 'consola/basic';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { routePath } from 'hono/route';
import { config } from '../config.js';
import { tracer } from '../logging.js';
import {
  clientAddress,
  routeTemplate,
  isRouteMatched,
  requestSpanName,
  requestAttributes,
  responseAttributes,
  consolaTypeForStatus
} from './http.js';

const remoteAddress = (c) => {
  let peer;
  try {
    peer = getConnInfo(c).remote.address;
  } catch {
    return null;
  }
  return clientAddress({
    peer,
    forwardedFor: c.req.header('X-Forwarded-For'),
    trustedProxyHops: config.trustedProxyHops
  });
};

// Map the matched Hono route to a template so logs stay stable across paths with dynamic params.
const matchedRoute = (c) => {
  try {
    return routeTemplate(routePath(c, -1));
  } catch {
    return null;
  }
};

const client = async (c, next) => {
  const ipAddress = remoteAddress(c);
  c.set('ipAddress', ipAddress);
  if (c.req.path === '/health') {
    return next();
  }
  const method = c.req.method;
  const userAgent = c.req.header('User-Agent');
  return tracer.startActiveSpan(
    requestSpanName({ method }),
    {
      kind: SpanKind.SERVER,
      attributes: requestAttributes({ method, url: c.req.url, ipAddress, userAgent })
    },
    async (span) => {
      try {
        await next();
        const route = matchedRoute(c);
        const status = c.res.status;
        span.updateName(requestSpanName({ method, route }));
        span.setAttributes(responseAttributes({ route, status, contentLength: c.res.headers.get('content-length') }));
        // Semconv reserves ERROR only for 5xx, not 4xx.
        if (status >= 500) {
          span.setStatus({ code: SpanStatusCode.ERROR });
        }
        // The span above already carries method/route/status/client/user-agent for every
        // request. Logging the same thing again on success just doubles row count; only
        // log non-2xx, where a plain log line is easier to alert on than querying spans.
        if (status >= 400) {
          const logAttributes = { 'http.response.status_code': status };
          if (ipAddress) {
            logAttributes['client.address'] = ipAddress;
          }
          if (userAgent) {
            logAttributes['user_agent.original'] = userAgent;
          }
          consola[consolaTypeForStatus(status)](
            `${method} ${isRouteMatched(route) ? route : '/*'} ${status}`,
            logAttributes
          );
        }
      } catch (error) {
        span.recordException(error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    }
  );
};

export { client };
