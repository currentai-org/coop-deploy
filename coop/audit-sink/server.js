'use strict';
/**
 * Audit sink for Coop CUSTOM_ACTION callbacks (chat-block / chat-block-child).
 *
 * Why it exists: a CUSTOM_ACTION requires a callbackUrl, and the LIVE sync rule path
 * AWAITS the webhook POST before returning `actionsTriggered` (RuleEngine ->
 * ActionPublisher). A slow/hanging callback eats Coop's 24s budget and can turn the
 * verdict into `[]`. So this returns an INSTANT 200 and only logs.
 *
 * The chat app does NOT depend on this for its decision — it keys on the action's
 * presence in the /content sync response. This sink is just a local, fast, reliable
 * audit trail (stdout). Zero dependencies (Node http).
 */
const http = require('node:http');

const PORT = Number(process.env.PORT || 9090);

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/healthz')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  let body = '';
  let size = 0;
  const MAX = 1_000_000; // 1MB guard
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size <= MAX) body += chunk;
  });
  req.on('end', () => {
    // Respond 200 IMMEDIATELY — never block Coop's sync budget.
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ received: true }));

    let parsed = body;
    try {
      parsed = JSON.parse(body);
    } catch {
      /* keep raw */
    }
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        sink: 'coop-action-audit',
        method: req.method,
        url: req.url,
        payload: parsed,
      }),
    );
  });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[audit-sink] listening on :${PORT} (instant-200, logs to stdout)`);
});