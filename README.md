# JEFF

![JEFF v0.5 sealed v3 benchmark result](public/media/jeff-v0.5-sealed-v3-benchmark-2026-09-28.png)

JEFF is an open, token-agnostic decision model and runtime for Agent NFTs. It turns structured identity, state, memory, policy, and proposal data into typed, machine-readable decisions that downstream systems can inspect.

JEFF v0.5 is intentionally shadow-only. It cannot sign, submit, publish, spend, or execute transactions. Every response keeps `executionAuthorized: false`.

## Released checkpoint

- Model: `jeff-agent-nft-nb-v0.5-evidence`
- Sealed v3 result: 203 of 216 typed decisions, or 93.98%
- Evaluation: 24 unseen cases with predictions frozen before independent labels
- Capability floors: all 7 families above 91%
- Protocol floors: all 6 protocols above 86%
- Mean confidence on wrong answers: 49.84%
- Runtime: dependency-free Node.js ESM
- Code and checkpoint: MIT
- Dataset: CC BY 4.0

This result supports the released shadow model only. It is not evidence of autonomous execution, economic performance, or universal superiority.

## Quick start

Requires Node.js 20 or newer. There are no runtime dependencies.

```bash
git clone https://github.com/ryjin111/JEFF.git
cd JEFF
npm test
npm run verify
npm run demo
```

Use the promoted, hash-bound checkpoint:

```js
import { inferJeffAgentNftPromoted } from './api/_lib/jeff-agent-nft-promoted.mjs';
import { JEFF_AGENT_NFT_CAPABILITY_QUESTIONS } from './api/_lib/jeff-agent-nft-capabilities.mjs';

const result = inferJeffAgentNftPromoted({
  agentNft: {
    chainId: 1,
    collection: '0x0000000000000000000000000000000000000001',
    tokenId: '1',
    account: '0x0000000000000000000000000000000000000002'
  },
  state: {
    proposal: 'Read the verified token-bound account state.',
    authorized: true,
    provenanceVerified: true,
    dataFresh: true,
    evidence: [{ verified: true }],
    ownerPolicy: { allowAutonomous: false }
  },
  questions: JEFF_AGENT_NFT_CAPABILITY_QUESTIONS
});

console.log(result.mode);                // shadow
console.log(result.executionAuthorized); // false
console.log(result.answers);
```

## What is included

- `api/_lib/`: typed contract, 28 capability questions, v0.5 inference runtime, promotion gate, promoted loader, and benchmark v2 scorer.
- `models/`: the released v0.5 checkpoint, model card, and MIT license.
- `datasets/`: the v0.5 evidence curriculum, dataset card, and CC BY 4.0 license.
- `benchmarks/`: sealed stimuli, independent labels, frozen predictions, result receipt, source manifest, and the v2 benchmark contract.
- `docs/`: model architecture, release readiness, and primary-source audit.
- `test/`: contract, runtime, benchmark, and release-integrity tests.

## Integrity and verification

`npm run verify` fails closed if a bound artifact changes. The promoted loader binds the checkpoint, runtime, and sealed receipt by SHA-256. The release verifier additionally checks the training dataset, frozen stimuli, labels, predictions, source manifest, source audit, licenses, promotion gate, and shadow execution boundary.

The canonical result receipt is:

`benchmarks/jeff/results/jeff-agent-nft-protocol-blind-v3.json`

## Benchmark design

The public v2 benchmark separates four model tracks:

1. Hard safety qualification.
2. Independently labeled decision quality and calibration.
3. Strict `pass^k` reliability under harmless context perturbations.
4. Agent NFT transfer invariance and previous-owner privacy.

Execution settlement and economic outcomes are separate runtime tracks. The released v0.5 score does not claim results for the new reliability or transfer tracks. See [the benchmark contract](benchmarks/jeff/AGENT_NFT_BENCHMARK_V2.md).

## Security boundary

Treat JEFF output as advice for policy and execution systems, never as authorization. Do not provide private keys, seed phrases, signatures, API secrets, or private user data. See [SECURITY.md](SECURITY.md).

## Status

JEFF v0.5 is production-ready for promoted shadow use. Autonomous wallet execution remains disabled and out of scope for this release.
