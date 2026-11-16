import { test } from 'node:test'
import assert from 'node:assert/strict'
import { jsonSafe } from '../src/engine/json.mjs'

test('jsonSafe drops undefined keys but keeps array positions', () => {
  const out = jsonSafe({ a: 1, b: undefined, c: { d: undefined, e: 2 }, arr: [1, undefined, 3] })
  assert.deepEqual(out, { a: 1, c: { e: 2 }, arr: [1, null, 3] })
  assert.equal('b' in out, false)
})

test('jsonSafe normalises non-finite numbers and bigint', () => {
  assert.deepEqual(jsonSafe({ a: NaN, b: Infinity, c: -Infinity, d: 10n }), { a: null, b: null, c: null, d: '10' })
})

test('jsonSafe survives a round trip and breaks cycles', () => {
  const cyclic = { a: 1 }; cyclic.self = cyclic
  const out = jsonSafe(cyclic)
  assert.equal(out.self, '[circular]')
  assert.deepEqual(JSON.parse(JSON.stringify(out)), out)
})
