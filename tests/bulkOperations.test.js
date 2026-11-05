import assert from 'node:assert/strict';
import test from 'node:test';
import { processWithConcurrency } from '../bulkOperations.js';

test('bulk processing respects concurrency and visits every item once', async () => {
  let active = 0;
  let maximum = 0;
  const visited = [];
  await processWithConcurrency(Array.from({ length: 20 }, (_, index) => index), 3, async item => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 2));
    visited.push(item);
    active -= 1;
  });
  assert.equal(maximum, 3);
  assert.deepEqual(visited.sort((left, right) => left - right), Array.from({ length: 20 }, (_, index) => index));
});

test('bulk processing clamps concurrency to ten', async () => {
  let active = 0;
  let maximum = 0;
  await processWithConcurrency(Array.from({ length: 20 }, (_, index) => index), 100, async () => {
    active += 1; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 2));
    active -= 1;
  });
  assert.equal(maximum, 10);
});
