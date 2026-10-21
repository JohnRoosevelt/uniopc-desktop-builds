'use strict';
const { isMainThread } = require('node:worker_threads');
const fs = require('node:fs');
if (isMainThread) {
  // This MUST be the first preload. No DNS/engine module is loaded before the
  // parent has attached our process to its kill-on-close Job Object.
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
}
// Fork and default Worker execArgv inheritance must not replay the private
// root handshake. Node can replay its private original argv in each Worker;
// every context must clean the public list used by fork(). Remove only our
// exact pair, after proving path AND file ID.
try {
  const path = require('node:path');
  const { isBuiltin } = require('node:module');
  const { fileURLToPath } = require('node:url');
  const key = value => {
    if (process.platform !== 'win32') return value;
    let normalized = path.win32.normalize(value);
    if (normalized.toLowerCase().startsWith('\\\\?\\unc\\')) normalized = '\\\\' + normalized.slice(8);
    else if (normalized.startsWith('\\\\?\\')) normalized = normalized.slice(4);
    return normalized.toLowerCase();
  };
  const identify = value => {
    const resolved = fs.realpathSync.native(value);
    const stat = fs.statSync(resolved, { bigint: true });
    if (!stat.isFile() || stat.ino <= 0n || stat.dev < 0n) throw new Error();
    return { path: key(resolved), dev: stat.dev, ino: stat.ino };
  };
  const self = identify(__filename);
  let pair = -1;
  for (let index = 0; index < process.execArgv.length; index++) {
    const argument = process.execArgv[index];
    if (['-e', '--eval', '-p', '--print'].includes(argument)) { index++; continue; }
    let value; let separate = false; let supported = false;
    if (argument === '--require' || argument === '-r' || argument === '--import') {
      value = process.execArgv[++index]; separate = true; supported = argument === '--require';
    } else if (argument.startsWith('--require=')) value = argument.slice(10);
    else if (argument.startsWith('--import=')) value = argument.slice(9);
    else if (argument.startsWith('-r') && !argument.startsWith('--')) value = argument.slice(2);
    else continue;
    if (typeof value !== 'string' || value.length === 0) throw new Error();
    if (isBuiltin(value)) continue;
    const candidate = identify(value.startsWith('file:') ? fileURLToPath(value) : require.resolve(value, { paths: [process.cwd()] }));
    const samePath = candidate.path === self.path;
    const sameFile = candidate.dev === self.dev && candidate.ino === self.ino;
    if (samePath !== sameFile) throw new Error();
    if (samePath) {
      if (!separate || !supported || pair !== -1) throw new Error();
      pair = index - 1;
    }
  }
  if (pair === -1) throw new Error();
  process.execArgv.splice(pair, 2);
} catch { process.exit(78); }
// Worker contexts sanitize their public argv for subsequent fork(), but must
// never consume stdin or install root startup telemetry/hooks.
if (isMainThread) {
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
}
