import { resolve } from 'node:path';
import { createInferenceLedger } from '../src/inference-ledger.mjs';

// Offline operator tool. Receipt IDs attest settled provider capacity; this
// command does not buy credits, send tokens, or independently verify funding.
// Run against a reconciled data root. No environment or key files are loaded.
const [command, root, json] = process.argv.slice(2);
const commands = new Set(['fund','grant','reconcile','balance','history','totals','pause','resume']);
if (!commands.has(command) || !root || (command !== 'totals' && !['pause','resume'].includes(command) && !json)) {
  console.error('Usage: node scripts/inference-admin.mjs fund|grant|reconcile|balance|history|totals|pause|resume DATA_ROOT [JSON]');
  process.exitCode = 1;
} else {
  let ledger;
  try {
    const input = json ? JSON.parse(json) : {};
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('JEFF_INFERENCE_INPUT_INVALID');
    ledger = createInferenceLedger({ dataRoot: resolve(root) });
    const result = command === 'balance' ? ledger.balance(input)
      : command === 'history' ? ledger.list(input)
        : command === 'totals' ? ledger.totals()
          : ['pause','resume'].includes(command) ? ledger.setPaused(command === 'pause')
            : ledger[command](input);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(/^JEFF_INFERENCE_[A-Z_]+$/.test(error.message) ? error.message : 'JEFF_INFERENCE_ADMIN_FAILED');
    process.exitCode = 1;
  } finally { ledger?.close(); }
}
