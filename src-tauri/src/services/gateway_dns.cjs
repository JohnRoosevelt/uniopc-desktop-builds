// Loaded with --require by Uniopc's owned Gateway only. No OS DNS/proxy writes,
// NODE_OPTIONS, runtime-vendor patches, or SSRF exceptions.
const dns = require('node:dns');
const dnsPromises = require('node:dns/promises');
const https = require('node:https');
const net = require('node:net');
const { syncBuiltinESMExports } = require('node:module');
const { domainToASCII } = require('node:url');
const { promisify } = require('node:util');
const resolverAgent = new https.Agent({ keepAlive: true, maxSockets: 4 });

function isFakeIp(address) {
  if (net.isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 198 && (b === 18 || b === 19);
  }
  // Clash Verge's default IPv6 fake range is 2001:2::/64.
  if (net.isIP(address) !== 6) return false;
  const url = new URL(`http://[${address}]/`);
  const normalized = url.hostname.slice(1, -1);
  return /^2001:2:(?:0:0:|:)/i.test(normalized);
}

function dnsError(code = 'EAI_AGAIN') {
  return Object.assign(new Error('Uniopc Gateway could not resolve Fake-IP through encrypted DNS'), { code });
}

function publicHostname(hostname) {
  const host = domainToASCII(String(hostname)).toLowerCase().replace(/\.$/, '');
  if (!host || host.length > 253 || net.isIP(host) || !host.includes('.')) return null;
  if (/(?:^|\.)(?:localhost|local|internal|lan|arpa)$/.test(host)) return null;
  return host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ? host : null;
}

function parseAnswer(body, hostname, type) {
  if (body.Status === 3) return [];
  if (body.Status !== 0 || body.TC || !body.Question?.some(q => q.type === type
    && q.name.toLowerCase().replace(/\.$/, '') === hostname)) throw dnsError();
  const answers = body.Answer || [];
  const names = new Set([hostname]);
  for (let depth = 0; depth < 16; depth++) {
    let changed = false;
    for (const record of answers) {
      if (record.type !== 5 || !names.has(record.name.toLowerCase().replace(/\.$/, ''))) continue;
      const name = record.data.toLowerCase().replace(/\.$/, '');
      if (!names.has(name)) { names.add(name); changed = true; }
    }
    if (!changed) break;
  }
  return answers.filter(r => r.type === type && names.has(r.name.toLowerCase().replace(/\.$/, '')))
    .map(r => {
      const family = net.isIP(r.data);
      if (family !== (type === 1 ? 4 : 6) || isFakeIp(r.data)) throw dnsError();
      // Return private answers unchanged: the existing OpenClaw SSRF guard
      // must reject them, rather than silently dropping a dangerous family.
      return { address: r.data, family };
    });
}

function query(server, hostname, type) {
  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname: server, port: 443,
      path: `/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`,
      headers: { accept: 'application/dns-json' }, agent: resolverAgent,
      // A fixed public IP avoids recursively resolving the resolver through
      // Fake-IP. TLS verification stays enabled; redirects are never followed.
    }, res => {
      if (res.statusCode !== 200) { res.resume(); reject(dnsError()); return; }
      let body = ''; let size = 0;
      res.setEncoding('utf8');
      res.on('data', chunk => {
        size += Buffer.byteLength(chunk);
        if (size > 65536) { req.destroy(dnsError()); return; }
        body += chunk;
      });
      res.on('error', () => reject(dnsError()));
      res.on('end', () => {
        try { resolve(parseAnswer(JSON.parse(body), hostname, type)); }
        catch { reject(dnsError()); }
      });
    });
    const timer = setTimeout(() => req.destroy(dnsError()), 8000);
    req.on('close', () => clearTimeout(timer));
    req.on('error', () => reject(dnsError()));
  });
}

async function encryptedLookup(hostname, family) {
  for (const server of ['1.1.1.1', '8.8.8.8']) {
    try {
      const types = family === 4 ? [1] : family === 6 ? [28] : [1, 28];
      const results = (await Promise.all(types.map(type => query(server, hostname, type)))).flat();
      if (!results.length) throw dnsError('ENOTFOUND');
      return results;
    } catch { /* Try the other fixed TLS resolver; never accept fake addresses. */ }
  }
  throw dnsError();
}

function createLookup(original, resolve = encryptedLookup) {
  const pending = new Map();
  return async function lookup(hostname, options = {}) {
    const opts = typeof options === 'number' ? { family: options } : options || {};
    const results = await original(hostname, { ...opts, all: true });
    let addresses = results;
    if (results.some(r => isFakeIp(r.address))) {
      const host = publicHostname(hostname);
      if (!host) throw dnsError('ENOTFOUND');
      // Mixed real/private and fake replies must still reach the SSRF guard.
      // Only replace an entirely synthetic set, never hide another address.
      if (!results.every(r => isFakeIp(r.address))) return opts.all ? results : results[0];
      const family = opts.family === 'IPv4' ? 4 : opts.family === 'IPv6' ? 6 : opts.family || 0;
      const key = `${host}:${family}`;
      if (!pending.has(key)) {
        if (pending.size >= 128) throw dnsError();
        pending.set(key, Promise.resolve().then(() => resolve(host, family)).finally(() => pending.delete(key)));
      }
      addresses = await pending.get(key);
      if (!addresses.length || addresses.some(r => !net.isIP(r.address) || isFakeIp(r.address))) throw dnsError();
    }
    return opts.all ? addresses : addresses[0];
  };
}

function install() {
  const lookup = createLookup(dnsPromises.lookup.bind(dnsPromises));
  dnsPromises.lookup = lookup;
  dns.lookup = function (hostname, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    if (typeof callback !== 'function') throw new TypeError('DNS callback is required');
    lookup(hostname, options).then(result => {
      if (options?.all) callback(null, result);
      else callback(null, result.address, result.family);
    }, callback);
  };
  dns.lookup[promisify.custom] = lookup;
  syncBuiltinESMExports();
}

module.exports = { createLookup, parseAnswer, isFakeIp, publicHostname, install, encryptedLookup, query };
if (process.execArgv.some((arg, index) => arg === '--require'
  && require('node:path').resolve(process.execArgv[index + 1] || '') === __filename)) {
  install();
}
