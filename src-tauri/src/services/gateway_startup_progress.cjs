'use strict';
// This MUST be the first preload. No DNS/engine module is loaded before the
// parent has attached our process to its kill-on-close Job Object.
const fs = require('node:fs');
const ack = Buffer.alloc(2);
let count = 0;
try {
  for (;;) {
    const n = fs.readSync(0, ack, count, 2 - count, null);
    if (n === 0) break;
    count += n;
    if (count === 2) process.exit(78);
  }
  if (count !== 1 || ack[0] !== 0xa7) process.exit(78);
} catch { process.exit(78); }
// fd 0 remains at EOF, matching the vendor's ordinary null stdin contract.
function emit(value) {
  try { fs.writeSync(2, `UNIOPC_GATEWAY_STARTUP ${JSON.stringify(value)}\n`); } catch {}
}
emit({event:'node_preload'});
try {
  const net = require('node:net');
  const original = net.Server.prototype.listen;
  net.Server.prototype.listen = function (...args) {
    let port;
    try {
      const first = args[0];
      port = typeof first === 'object' && first !== null ? Number(first.port) : Number(first);
      if (Number.isInteger(port) && port > 0 && port <= 65535) {
        emit({event:'http_listen_requested',port});
        this.once('listening', () => {
          try { const address = this.address(); if (address && typeof address === 'object') emit({event:'listening',port:address.port}); } catch {}
        });
      }
    } catch {}
    return Reflect.apply(original, this, args);
  };
  let due = performance.now() + 10000;
  setInterval(() => {
    try {
      const now = performance.now();
      emit({event:'heartbeat',uptime_ms:Math.floor(process.uptime()*1000),rss_bytes:process.memoryUsage().rss,lateness_ms:Math.max(0,Math.floor(now-due))});
      due = now + 10000;
    } catch {}
  },10000).unref();
} catch {}
