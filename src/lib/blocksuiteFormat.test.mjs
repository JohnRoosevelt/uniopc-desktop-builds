import assert from 'node:assert/strict'
import {
  BLOCKSUITE_BODY_FORMAT,
  INVALID_BLOCKSUITE_BODY_ERROR,
  isBlockSuiteCrdtBody,
  parseBlockSuiteBody,
  stringifyBlockSuiteCrdtBody,
} from './blocksuiteFormat.js'

const encoded = Buffer.from(new Uint8Array([1, 2, 3, 4])).toString('base64')

assert.equal(BLOCKSUITE_BODY_FORMAT, 'blocksuite_crdt')
assert.equal(isBlockSuiteCrdtBody(encoded), true)
assert.equal(parseBlockSuiteBody(encoded).kind, 'crdt')
assert.deepEqual(parseBlockSuiteBody(encoded).bytes, new Uint8Array([1, 2, 3, 4]))
assert.equal(stringifyBlockSuiteCrdtBody(new Uint8Array([5, 6])), Buffer.from([5, 6]).toString('base64'))

for (const invalid of [
  '',
  '   ',
  '{ "type": "page", "meta": {}, "blocks": {} }',
  Buffer.from('{ "type": "page", "meta": {}, "blocks": {} }').toString('base64'),
  '{ "schema": "uniopc.blocksuite.v1", "kind": "page", "title": "Old", "blocks": [] }',
  Buffer.from('{ "schema": "uniopc.blocksuite.v1", "kind": "page", "title": "Old", "blocks": [] }').toString('base64'),
]) {
  assert.throws(() => parseBlockSuiteBody(invalid), new RegExp(INVALID_BLOCKSUITE_BODY_ERROR))
}

console.log('ok - blocksuite crdt format helpers reject legacy bodies')
