import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkspaceStore } from '../src/workspace.mjs';
import { scopeDirectory } from '../src/scope.mjs';

const testRoot = dirname(fileURLToPath(import.meta.url));
const owner = '0x' + '11'.repeat(20), nextOwner = '0x' + '22'.repeat(20);
const scope = { chainId: 4663, collection: '0x' + '33'.repeat(20), tokenId: '35', owner, ownerEpoch: 0 };
const memory = { type: 'memory.save', title: 'Writing preference', text: 'Use short paragraphs.' };
const schedule = { type: 'schedule.create', objective: 'Draft a daily project summary.', intervalMinutes: 60,
  maxRuns: 3, expiresAt: '2026-10-10T12:00:00.000Z' };
const rejects = (operation, pattern) => assert.rejects(async () => operation(), pattern);

async function fixture(t) {
  const dataRoot = await mkdtemp(resolve(testRoot, '.workspace-actions-'));
  t.after(async () => {
    assert.equal(dirname(dataRoot), testRoot);
    await rm(dataRoot, { recursive: true, force: true });
  });
  const ownership = new Map([['35', { owner, ownerEpoch: 0 }], ['36', { owner, ownerEpoch: 0 }]]);
  let clock = Date.parse('2026-10-09T12:00:00.000Z'), resolver, reads = 0;
  const options = { dataRoot, now: () => clock,
    resolveOwner: async candidate => { reads++; return resolver ? resolver(candidate, reads) : ownership.get(candidate.tokenId); } };
  const store = createWorkspaceStore(options);
  const bind = async (source = 'manual', candidate = scope) => {
    const conversation = await store.createConversation(candidate, { title: 'Chat actions' }), jobId = randomUUID();
    await store.bindJob(candidate, { jobId, conversationId: conversation.id, objective: 'Remember my writing preference.', source });
    return { jobId, conversationId: conversation.id };
  };
  return { dataRoot, store, bind, reopen: () => createWorkspaceStore(options),
    file: (candidate = scope) => resolve(scopeDirectory(dataRoot, candidate), 'workspace-state.json'),
    change(tokenId, next, epoch) { ownership.set(tokenId, { owner: next, ownerEpoch: epoch }); },
    resolver(value) { resolver = value; reads = 0; }, advance(ms = 1000) { clock += ms; } };
}

test('chat memory proposal and its applied receipt survive restart with one durable memory', async t => {
  const f = await fixture(t), { jobId } = await f.bind();
  const proposal = await f.store.proposeChatAction(scope, jobId, memory, { timeZone: 'Asia/Taipei' });
  assert.deepEqual(proposal, { schema: 'jeff-chat-action-v1', id: jobId, type: memory.type,
    parameters: { title: memory.title, text: memory.text }, status: 'pending', createdAt: '2026-10-09T12:00:00.000Z', timeZone: 'Asia/Taipei' });
  assert.deepEqual((await f.reopen().getJobBinding(scope, jobId)).action, proposal);
  f.advance();
  const applied = await f.reopen().applyChatMemory(scope, jobId);
  assert.equal(applied.status, 'applied');
  assert.equal(applied.appliedAt, '2026-10-09T12:00:01.000Z');
  const persisted = JSON.parse(await readFile(f.file(), 'utf8'));
  assert.deepEqual(persisted.jobBindings[jobId].action, applied);
  assert.deepEqual(persisted.memories, [{ id: applied.result.memoryId, title: memory.title, text: memory.text,
    createdAt: applied.appliedAt, updatedAt: applied.appliedAt }]);
  assert.deepEqual(await f.reopen().applyChatMemory(scope, jobId), applied);
  assert.equal((await f.reopen().get(scope)).memories.length, 1);
});

test('concurrent memory confirmations are serialized and never insert duplicate notes', async t => {
  const f = await fixture(t), { jobId } = await f.bind();
  await f.store.proposeChatAction(scope, jobId, memory);
  const receipts = await Promise.all(Array.from({ length: 8 }, () => f.store.applyChatMemory(scope, jobId)));
  for (const receipt of receipts) assert.deepEqual(receipt, receipts[0]);
  const saved = await f.store.get(scope);
  assert.equal(saved.memories.length, 1);
  assert.equal(saved.activity.filter(item => item.type === 'memory.created').length, 1);
});

test('simultaneous confirmation and dismissal commit exactly one terminal action state', async t => {
  const f = await fixture(t), first = await f.bind(), second = await f.bind();
  await f.store.proposeChatAction(scope, first.jobId, memory);
  await f.store.proposeChatAction(scope, second.jobId, { ...memory, text: 'A different note.' });
  const appliedFirst = await Promise.allSettled([
    f.store.applyChatMemory(scope, first.jobId), f.store.dismissChatAction(scope, first.jobId),
  ]);
  assert.equal(appliedFirst[0].status, 'fulfilled');
  assert.equal(appliedFirst[1].status, 'rejected');
  assert.match(appliedFirst[1].reason.message, /JEFF_WORKSPACE_CONFLICT/);
  const dismissedFirst = await Promise.allSettled([
    f.store.dismissChatAction(scope, second.jobId), f.store.applyChatMemory(scope, second.jobId),
  ]);
  assert.equal(dismissedFirst[0].status, 'fulfilled');
  assert.equal(dismissedFirst[1].status, 'rejected');
  assert.match(dismissedFirst[1].reason.message, /JEFF_WORKSPACE_CONFLICT/);
  const saved = await f.reopen().get(scope);
  assert.equal(saved.jobBindings[first.jobId].action.status, 'applied');
  assert.equal(saved.jobBindings[second.jobId].action.status, 'dismissed');
  assert.deepEqual(saved.memories.map(item => item.text), [memory.text]);
});

test('confirmation retries cannot recreate a deleted memory or overwrite an edited note', async t => {
  const f = await fixture(t), { jobId } = await f.bind();
  await f.store.proposeChatAction(scope, jobId, memory);
  const applied = await f.store.applyChatMemory(scope, jobId), id = applied.result.memoryId;
  await f.store.saveMemory(scope, { id, title: 'New preference', text: 'Use detailed paragraphs.' });
  assert.deepEqual(await f.reopen().applyChatMemory(scope, jobId), applied);
  assert.equal((await f.store.get(scope)).memories[0].text, 'Use detailed paragraphs.');
  await f.store.deleteMemory(scope, id);
  assert.deepEqual(await f.reopen().applyChatMemory(scope, jobId), applied);
  assert.deepEqual((await f.store.get(scope)).memories, []);
});

test('proposal retries preserve original parameters and reject replacements or authority changes', async t => {
  const f = await fixture(t), { jobId } = await f.bind();
  const proposal = await f.store.proposeChatAction(scope, jobId, memory, { timeZone: 'Asia/Taipei' });
  assert.deepEqual(await f.reopen().proposeChatAction(scope, jobId, { text: memory.text, title: memory.title, type: memory.type }, { timeZone: 'Asia/Taipei' }), proposal);
  for (const [action, options] of [[{ ...memory, text: 'Replacement content' }, { timeZone: 'Asia/Taipei' }],
    [schedule, { timeZone: 'Asia/Taipei' }], [memory, { timeZone: 'UTC' }]]) {
    await rejects(() => f.store.proposeChatAction(scope, jobId, action, options), /JEFF_WORKSPACE_CONFLICT/);
  }
  assert.deepEqual((await f.store.getJobBinding(scope, jobId)).action, proposal);
  assert.deepEqual((await f.store.get(scope)).memories, []);
});

test('queued proposals copy input data and returned receipts cannot mutate stored plans', async t => {
  const f = await fixture(t), { jobId } = await f.bind();
  const input = { ...memory }, pending = f.store.proposeChatAction(scope, jobId, input);
  input.text = 'Caller mutation after validation';
  const proposal = await pending;
  assert.equal(proposal.parameters.text, memory.text);
  proposal.parameters.text = 'Caller mutation of result';
  proposal.status = 'applied';
  assert.equal((await f.reopen().getJobBinding(scope, jobId)).action.parameters.text, memory.text);
  assert.equal((await f.reopen().getJobBinding(scope, jobId)).action.status, 'pending');
});

test('scheduled bindings and missing jobs cannot gain host-action authority', async t => {
  const f = await fixture(t), { jobId } = await f.bind('schedule');
  const before = await readFile(f.file(), 'utf8');
  await rejects(() => f.store.proposeChatAction(scope, jobId, memory), /JEFF_CHAT_ACTION_DENIED/);
  await rejects(() => f.store.proposeChatAction(scope, randomUUID(), memory), /JEFF_WORKSPACE_NOT_FOUND/);
  await rejects(() => f.store.applyChatMemory(scope, jobId), /JEFF_WORKSPACE_NOT_FOUND/);
  assert.equal(await readFile(f.file(), 'utf8'), before);
});

test('chat plans cannot cross NFT, account or returning-holder scopes', async t => {
  const f = await fixture(t), { jobId } = await f.bind();
  await f.store.proposeChatAction(scope, jobId, memory);
  for (const candidate of [{ ...scope, tokenId: '36' }, { kind: 'account', chainId: scope.chainId, owner }]) {
    await rejects(() => f.store.applyChatMemory(candidate, jobId), /JEFF_WORKSPACE_NOT_FOUND/);
    assert.equal(await f.store.getJobBinding(candidate, jobId), null);
  }
  f.change('35', nextOwner, 1);
  await rejects(() => f.store.applyChatMemory(scope, jobId), /JEFF_OWNER_REQUIRED/);
  await rejects(() => f.store.dismissChatAction(scope, jobId), /JEFF_OWNER_REQUIRED/);
  const transferred = { ...scope, owner: nextOwner, ownerEpoch: 1 };
  await rejects(() => f.store.applyChatMemory(transferred, jobId), /JEFF_WORKSPACE_NOT_FOUND/);
  f.change('35', owner, 2);
  await rejects(() => f.reopen().applyChatMemory(scope, jobId), /JEFF_OWNER_REQUIRED/);
  await rejects(() => f.store.applyChatMemory({ ...scope, ownerEpoch: 2 }, jobId), /JEFF_WORKSPACE_NOT_FOUND/);
});

test('pause blocks proposed and memory writes while draft dismissal remains available', async t => {
  const f = await fixture(t), { jobId } = await f.bind();
  await f.store.proposeChatAction(scope, jobId, memory);
  await f.store.updateSettings(scope, { paused: true });
  const before = await readFile(f.file(), 'utf8');
  await rejects(() => f.store.proposeChatAction(scope, jobId, memory), /JEFF_AGENT_PAUSED/);
  await rejects(() => f.store.applyChatMemory(scope, jobId), /JEFF_AGENT_PAUSED/);
  assert.equal(await readFile(f.file(), 'utf8'), before);
  const dismissed = await f.store.dismissChatAction(scope, jobId);
  assert.equal(dismissed.status, 'dismissed');
  assert.deepEqual(await f.reopen().dismissChatAction(scope, jobId), dismissed);
  await f.store.updateSettings(scope, { paused: false });
  await rejects(() => f.store.applyChatMemory(scope, jobId), /JEFF_WORKSPACE_CONFLICT/);
  assert.deepEqual((await f.store.get(scope)).memories, []);
});

test('schedule finalization is durable, idempotent and cannot switch the authorized grant', async t => {
  const f = await fixture(t), { jobId } = await f.bind();
  const proposed = { ...schedule, firstRunAt: '2026-10-09T13:00:00.000Z' };
  await f.store.proposeChatAction(scope, jobId, proposed, { timeZone: 'Asia/Taipei' });
  await rejects(() => f.store.applyChatMemory(scope, jobId), /JEFF_WORKSPACE_CONFLICT/);
  await f.store.updateSettings(scope, { paused: true });
  const scheduleId = randomUUID(), applied = await f.store.finishChatSchedule(scope, jobId, scheduleId);
  assert.equal(applied.status, 'applied');
  assert.deepEqual(applied.result, { scheduleId });
  assert.deepEqual(applied.parameters, { objective: proposed.objective, intervalMinutes: proposed.intervalMinutes,
    maxRuns: proposed.maxRuns, expiresAt: proposed.expiresAt, firstRunAt: proposed.firstRunAt });
  assert.deepEqual(await f.reopen().finishChatSchedule(scope, jobId, scheduleId), applied);
  await rejects(() => f.store.finishChatSchedule(scope, jobId, randomUUID()), /JEFF_WORKSPACE_CONFLICT/);
  await rejects(() => f.store.dismissChatAction(scope, jobId), /JEFF_WORKSPACE_CONFLICT/);
  assert.deepEqual((await f.store.get(scope)).memories, []);
});

test('dismissed schedule plans cannot be finalized and unrelated memory plans reject grants', async t => {
  const f = await fixture(t), first = await f.bind(), second = await f.bind();
  await f.store.proposeChatAction(scope, first.jobId, schedule);
  await f.store.proposeChatAction(scope, second.jobId, memory);
  await f.store.dismissChatAction(scope, first.jobId);
  await rejects(() => f.store.finishChatSchedule(scope, first.jobId, randomUUID()), /JEFF_WORKSPACE_CONFLICT/);
  await rejects(() => f.store.finishChatSchedule(scope, second.jobId, randomUUID()), /JEFF_WORKSPACE_CONFLICT/);
});

test('invalid actions and non-IANA time zones leave durable workspace state unchanged', async t => {
  const f = await fixture(t), { jobId } = await f.bind(), before = await readFile(f.file(), 'utf8');
  for (const action of [null, {}, { ...memory, type: 'shell.exec' }, { ...memory, trusted: true },
    { ...memory, text: 'x'.repeat(4001) }, { ...schedule, maxRuns: 25 }]) {
    await rejects(() => f.store.proposeChatAction(scope, jobId, action), /JEFF_CHAT_ACTION_INVALID/);
  }
  for (const timeZone of ['', 'Nowhere/Clock', '+08:00', 'Asia/Taipei\n', 'x'.repeat(81), 8, null]) {
    await rejects(() => f.store.proposeChatAction(scope, jobId, memory, { timeZone }), /JEFF_CHAT_ACTION_INVALID/);
  }
  assert.equal(await readFile(f.file(), 'utf8'), before);
});

test('IANA aliases are canonicalized once and accepted on an idempotent proposal retry', async t => {
  const f = await fixture(t), { jobId } = await f.bind();
  const proposal = await f.store.proposeChatAction(scope, jobId, memory, { timeZone: 'US/Eastern' });
  assert.equal(proposal.timeZone, 'America/New_York');
  assert.deepEqual(await f.reopen().proposeChatAction(scope, jobId, memory, { timeZone: 'America/New_York' }), proposal);
});

test('memory capacity failure keeps the original chat plan pending without claiming success', async t => {
  const f = await fixture(t), { jobId } = await f.bind();
  await f.store.proposeChatAction(scope, jobId, memory);
  for (let i = 0; i < 32; i++) await f.store.saveMemory(scope, { title: `Existing ${i}`, text: `Existing note ${i}` });
  const before = await readFile(f.file(), 'utf8');
  await rejects(() => f.store.applyChatMemory(scope, jobId), /JEFF_WORKSPACE_FULL/);
  assert.equal(await readFile(f.file(), 'utf8'), before);
  assert.equal((await f.reopen().getJobBinding(scope, jobId)).action.status, 'pending');
});

test('ownership recheck prevents an action and its memory from committing after transfer', async t => {
  const f = await fixture(t), { jobId } = await f.bind();
  await f.store.proposeChatAction(scope, jobId, memory);
  const before = await readFile(f.file(), 'utf8');
  f.resolver((candidate, reads) => reads >= 2 ? { owner: nextOwner, ownerEpoch: 1 } : { owner, ownerEpoch: 0 });
  await rejects(() => f.store.applyChatMemory(scope, jobId), /JEFF_OWNER_REQUIRED/);
  assert.equal(await readFile(f.file(), 'utf8'), before);
  f.resolver(() => { throw new Error('RPC_UNAVAILABLE'); });
  await rejects(() => f.store.dismissChatAction(scope, jobId), /RPC_UNAVAILABLE/);
  assert.equal(await readFile(f.file(), 'utf8'), before);
});

test('malformed durable action journals fail closed and cannot be replaced by another proposal', async t => {
  const f = await fixture(t), { jobId } = await f.bind();
  await f.store.proposeChatAction(scope, jobId, memory);
  const saved = await f.store.get(scope), base = saved.jobBindings[jobId].action;
  const corruptions = [null, { ...base, schema: 'other' }, { ...base, id: randomUUID() },
    { ...base, privileged: true }, { ...base, parameters: { ...base.parameters, trusted: true } },
    { ...base, parameters: { ...base.parameters, type: 'memory.save' } },
    { ...base, timeZone: 'Nowhere/Clock' }, { ...base, status: 'applied' },
    { ...base, status: 'applied', appliedAt: base.createdAt, result: { scheduleId: randomUUID() } },
    { ...base, status: 'applied', appliedAt: '2026-10-08T12:00:00.000Z', result: { memoryId: randomUUID() } },
    { ...base, status: 'dismissed', dismissedAt: base.createdAt, result: { memoryId: randomUUID() } },
    { ...base, status: 'pending', appliedAt: base.createdAt }];
  for (const action of corruptions) {
    const value = structuredClone(saved); value.jobBindings[jobId].action = action;
    const raw = JSON.stringify(value); await writeFile(f.file(), raw);
    await rejects(() => f.reopen().get(scope), /JEFF_WORKSPACE_STORAGE_UNAVAILABLE/);
    await rejects(() => f.store.proposeChatAction(scope, jobId, memory), /JEFF_WORKSPACE_STORAGE_UNAVAILABLE/);
    assert.equal(await readFile(f.file(), 'utf8'), raw);
  }
  const scheduled = structuredClone(saved); scheduled.jobBindings[jobId].source = 'schedule';
  await writeFile(f.file(), JSON.stringify(scheduled));
  await rejects(() => f.reopen().get(scope), /JEFF_WORKSPACE_STORAGE_UNAVAILABLE/);
});

test('legacy bindings remain readable and conversation removal discards only its action drafts', async t => {
  const f = await fixture(t), first = await f.bind(), second = await f.bind();
  assert.equal(Object.hasOwn((await f.reopen().getJobBinding(scope, first.jobId)), 'action'), false);
  await f.store.proposeChatAction(scope, first.jobId, memory);
  await f.store.proposeChatAction(scope, second.jobId, schedule);
  await f.store.applyChatMemory(scope, first.jobId);
  await f.store.deleteConversation(scope, first.conversationId);
  assert.equal(await f.reopen().getJobBinding(scope, first.jobId), null);
  assert.equal((await f.reopen().getJobBinding(scope, second.jobId)).action.status, 'pending');
  assert.equal((await f.reopen().get(scope)).memories.length, 1);
});
