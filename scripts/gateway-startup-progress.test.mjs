import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const preload = fileURLToPath(new URL('../src-tauri/src/services/gateway_startup_progress.cjs', import.meta.url));
const run = input => spawnSync(process.execPath, ['--require', preload, '-e', "process.stdout.write('body');require('node:fs').writeSync(1,require('node:fs').readFileSync(0))"], {input, timeout:3000});
test('first preload requires exactly one ACK plus EOF and preserves vendor EOF', () => {
  for (const input of [Buffer.alloc(0),Buffer.from([0]),Buffer.from([0xa7,0]),Buffer.from([0xa7,0xa7,0xa7])]) {
    const result = run(input); assert.equal(result.status,78); assert.equal(result.stdout.toString(),'');
  }
  const result = run(Buffer.from([0xa7])); assert.equal(result.status,0); assert.equal(result.stdout.toString(),'body');
  assert.match(result.stderr.toString(),/UNIOPC_GATEWAY_STARTUP {"event":"node_preload"}/);
});
test('entry and its descendant cannot run until ACK and close', async () => {
  const child = spawn(process.execPath,['--require',preload,'-e',"require('node:child_process').spawnSync(process.execPath,['-e',\"process.stdout.write('grandchild')\"],{stdio:['ignore',1,2]})"]);
  let output=''; child.stdout.on('data', chunk => output += chunk);
  const exited = new Promise(resolve => child.on('close',resolve));
  await new Promise(resolve => setTimeout(resolve,100)); assert.equal(output,'');
  child.stdin.write(Buffer.from([0xa7]));
  await new Promise(resolve => setTimeout(resolve,100)); assert.equal(output,'');
  child.stdin.end(); assert.equal(await exited,0); assert.equal(output,'grandchild');
});
test('listen emits only fixed numeric events and heartbeat timer does not hold exit', () => {
  const result = spawnSync(process.execPath,['--require',preload,'-e',"const net=require('node:net');const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>{const next=net.createServer();next.listen(port,'127.0.0.1',()=>{process.stdout.write(String(port));next.close()})})})"],{input:Buffer.from([0xa7]),timeout:3000});
  assert.equal(result.status,0);
  const events=result.stderr.toString().trim().split('\n').map(line=>JSON.parse(line.slice('UNIOPC_GATEWAY_STARTUP '.length)));
  assert.equal(events[0].event,'node_preload');
  const port=Number(result.stdout.toString());
  assert.deepEqual(events.slice(1),[{event:'http_listen_requested',port},{event:'listening',port}]);
});
