import { generateKeyPairSync, randomBytes } from 'node:crypto';

import { createInMemoryJeffMemoryAdapter } from '../api/_lib/jeff-authorized-memory.mjs';
import { hashJeffBrainValue } from '../api/_lib/jeff-brain-common.mjs';
import {
  createInMemoryJeffHolderStore,
  createJeffAesGcmMemoryCrypto,
  createJeffEd25519ReceiptSigner,
  createJeffEd25519ReceiptVerifier,
  createJeffHolderRuntime,
  verifyJeffHolderReceipt,
} from '../api/_lib/jeff-holder-runtime.mjs';

const wallet = '0x1000000000000000000000000000000000000001';
const agentNft = {
  chainId: 8453,
  collection: '0x3000000000000000000000000000000000000003',
  tokenId: '7',
  account: '0x4000000000000000000000000000000000000004',
};

function candidate(id) {
  return {
    id,
    title: `Candidate ${id}`,
    steps: ['Read verified holder status.', 'Prepare a concise response.'],
    toolProposals: [{
      tool: 'holder.status',
      purpose: 'Confirm current Agent NFT ownership.',
      input: { tokenId: agentNft.tokenId },
    }],
    expectedOutcome: 'A verified status summary is prepared.',
    risks: ['Ownership can change after the observation.'],
    reversibility: 'Read-only and reversible.',
  };
}

let providerCalls = 0;
const provider = {
  model: 'jeff-holder-local-demo',
  async complete({ phase }) {
    providerCalls += 1;
    if (phase === 'plan') {
      return {
        situation: 'The holder requested a verified Agent NFT status summary.',
        unknowns: ['Future ownership changes are not known.'],
        candidates: [candidate('inspect'), candidate('wait')],
        recommendedCandidateId: 'inspect',
      };
    }
    return { candidateId: 'inspect', verdict: 'accept', issues: [] };
  },
};

const ownershipResolver = {
  async resolveCurrentOwner(subject) {
    return {
      schema: 'jeff-holder-ownership-attestation-v1',
      agentNftSha256: hashJeffBrainValue(subject),
      currentOwner: wallet,
      ownerEpoch: 1,
      observedAt: new Date().toISOString(),
    };
  },
};

const walletVerifier = {
  async verify(input) {
    return {
      schema: 'jeff-wallet-signature-verification-v1',
      wallet: input.wallet,
      challengeSha256: input.challengeSha256,
      verified: input.signature === 'local-demo-signature',
      observedAt: new Date().toISOString(),
    };
  },
};

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const receiptSigner = createJeffEd25519ReceiptSigner({
  privateKey,
  keyId: 'local-demo-key',
});
const receiptVerifier = createJeffEd25519ReceiptVerifier({
  publicKey,
  keyId: 'local-demo-key',
});

const runtime = createJeffHolderRuntime({
  store: createInMemoryJeffHolderStore(),
  walletVerifier,
  ownershipResolver,
  provider,
  memoryAdapter: createInMemoryJeffMemoryAdapter(),
  memoryCrypto: createJeffAesGcmMemoryCrypto({ key: randomBytes(32) }),
  receiptSigner,
  relyingPartyOrigin: 'http://localhost',
});

const challenge = await runtime.issueChallenge({
  domain: 'localhost',
  uri: 'http://localhost/jeff-holder-alpha',
  wallet,
  agentNft,
});

const session = await runtime.boot({
  challengeSha256: challenge.challengeSha256,
  signature: 'local-demo-signature',
});

await runtime.remember({
  sessionId: session.sessionId,
  id: 'report_style',
  content: 'Prefer concise reports with verified evidence.',
  source: 'holder-approved-demo',
  expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
});

const output = await runtime.run({
  sessionId: session.sessionId,
  objective: 'Evaluate options and recommend a concise Agent NFT status report.',
});

console.log(JSON.stringify({
  warning: 'Local demonstration with mock wallet and ownership adapters only.',
  instanceId: session.instanceId,
  mode: output.result.mode,
  executionAuthorized: output.result.executionAuthorized,
  providerCalls,
  readOnlyToolsExecuted: output.receipt.readOnlyToolsExecuted,
  signedReceiptValid: verifyJeffHolderReceipt(output.receipt, receiptVerifier),
  receiptSha256: output.receipt.receiptSha256,
}, null, 2));
