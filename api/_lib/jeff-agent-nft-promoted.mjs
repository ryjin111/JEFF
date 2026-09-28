import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { inferJeffAgentNftLearned } from './jeff-agent-nft-learned-v0.5.mjs';
import { assessJeffModelPromotion } from './jeff-model-promotion.mjs';

const EXPECTED = Object.freeze({
  checkpointSha256: '1543685838160edbb1f25c23d3706261a6e94184362bfe64c541ab9651374e19',
  runtimeSha256: 'ccf920c8b4c6998baf327eb10ece2fec0512ff624d05852cdb83ae7d39b084ec',
  receiptSha256: 'fa5716f2cfee95e2c4f47b5a5fd401564023116e66709c44ba42c15f846923b4',
  sourceManifestSha256: 'ceff1056594df59bb9d302b78026d017d3daad617e8d4bf2946225c094e7b4bf',
  sourceAuditSha256: 'f7dd45a1fc24df600fe869cdf3cfdb2817823e2793e237289d6836e79e5a8c75',
});
const paths = Object.freeze({
  checkpoint: new URL('../../models/jeff-agent-nft-nb-v0.5-evidence/checkpoint.json', import.meta.url),
  runtime: new URL('./jeff-agent-nft-learned-v0.5.mjs', import.meta.url),
  receipt: new URL('../../benchmarks/jeff/results/jeff-agent-nft-protocol-blind-v3.json', import.meta.url),
});
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const readBoundFile = (path, expectedHash, errorCode) => {
  const text = readFileSync(path, 'utf8');
  if (sha256(text) !== expectedHash) throw new Error(errorCode);
  return text;
};

const checkpointText = readBoundFile(paths.checkpoint, EXPECTED.checkpointSha256, 'JEFF_PROMOTED_CHECKPOINT_INTEGRITY_FAILED');
readBoundFile(paths.runtime, EXPECTED.runtimeSha256, 'JEFF_PROMOTED_RUNTIME_INTEGRITY_FAILED');
const receiptText = readBoundFile(paths.receipt, EXPECTED.receiptSha256, 'JEFF_PROMOTED_RECEIPT_INTEGRITY_FAILED');
const checkpoint = JSON.parse(checkpointText);
const receipt = JSON.parse(receiptText);
const assessment = assessJeffModelPromotion(receipt);

if (!assessment.eligible || assessment.executionAuthorized !== false) throw new Error('JEFF_PROMOTED_GATE_FAILED');
if (receipt.checkpointSha256 !== EXPECTED.checkpointSha256 || receipt.runtimeSha256 !== EXPECTED.runtimeSha256) {
  throw new Error('JEFF_PROMOTED_BINDING_FAILED');
}
if (receipt.model !== checkpoint.model) throw new Error('JEFF_PROMOTED_MODEL_MISMATCH');

export const JEFF_PROMOTED_MODEL = Object.freeze({
  model: checkpoint.model,
  mode: 'shadow',
  executionAuthorized: false,
  promotionReceipt: 'jeff-agent-nft-protocol-blind-v3',
  observedAccuracy: assessment.observed,
  hashes: EXPECTED,
});

export function inferJeffAgentNftPromoted(request) {
  const response = inferJeffAgentNftLearned(checkpoint, request);
  if (response.mode !== 'shadow' || response.executionAuthorized !== false) {
    throw new Error('JEFF_PROMOTED_AUTHORITY_BREACH');
  }
  return response;
}
