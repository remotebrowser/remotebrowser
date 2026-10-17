// The guest's Chromium reports its websocket URL with its own host and port;
// clients must reach it through the forwarded loopback port instead.
const rewriteWsUrl = (wsUrl, baseUrl) => {
  const base = new URL(baseUrl);
  const parsed = new URL(wsUrl);
  parsed.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  parsed.hostname = base.hostname;
  parsed.port = base.port;
  return parsed.toString();
};

const fetchWebSocketDebuggerUrl = async (fetchImpl, baseUrl, timeoutMs) => {
  const response = await fetchImpl(`${baseUrl}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    throw new Error(`CDP /json/version answered HTTP ${response.status}`);
  }
  const data = await response.json().catch(() => null);
  if (!data || typeof data.webSocketDebuggerUrl !== 'string') {
    throw new Error('CDP /json/version carried no webSocketDebuggerUrl');
  }
  return data.webSocketDebuggerUrl;
};

export { fetchWebSocketDebuggerUrl, rewriteWsUrl };
