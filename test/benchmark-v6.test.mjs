import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const stimuliUrl = new URL('../benchmarks/jeff/v6/jeff-v0.9-canonical-reliability-v6.stimuli.json', import.meta.url);

test('v6 matches its private commitment and contains no labels', async () => {
  const text = await readFile(stimuliUrl, 'utf8');
  const stimuli = JSON.parse(text);
  assert.equal(createHash('sha256').update(text).digest('hex'), '81f754923c6f53988532637e868dc686d2ef7ce3c4dfccc7a2a0db56f55c66d3');
  assert.equal(stimuli.schema, 'jeff-agent-nft-v6-canonical-reliability-stimuli-v1');
  assert.equal(stimuli.labelStatus, 'withheld');
  assert.equal(stimuli.predictionsMustFreezeBeforeLabels, true);
  assert.equal(stimuli.k, 8);
  assert.equal(stimuli.questionIds.length, 8);
  assert.equal(stimuli.cases.length, 24);
  assert.equal(new Set(stimuli.cases.map(({ id }) => id)).size, 24);
  assert.equal(text.includes('"expected"'), false);
  assert.equal(text.includes('"forbidden"'), false);
  const groups = new Map();
  for (const entry of stimuli.cases) {
    const entries = groups.get(entry.transfer.group) ?? [];
    entries.push(entry);
    groups.set(entry.transfer.group, entries);
  }
  assert.equal(groups.size, 12);
  for (const entries of groups.values()) {
    assert.equal(entries.length, 2);
    assert.deepEqual(new Set(entries.map(({ transfer }) => transfer.phase)), new Set(['before', 'after']));
  }
});
