# JEFF Bankr read-only adapter

The JEFF Bankr adapter is the first isolated integration boundary between JEFF Brain and Bankr. It is deliberately limited to authenticated wallet reads and swap quotes. It cannot swap, transfer, sign, submit, pay, launch tokens, or call the Bankr Agent API.

## Allowed surface

- `GET https://api.bankr.bot/wallet/portfolio`
- `POST https://api.bankr.bot/wallet/swap-quote`

Bankr documents the quote endpoint as a read that remains available to read-only API keys. The adapter uses an exact host and path allowlist, strict input and response schemas, response-size limits, sanitized upstream failures, and hash-bound receipts.

Portfolio responses are normalized from the documented wallet, chain-balance, token, PnL, and NFT fields. Balance keys must match the requested chain filter. Swap quotes bind both chains and tokens plus the sell amount to the normalized request. Only documented optional quote fields are accepted, and a returned slippage value must match the requested value or Bankr's default of 500 basis points.

Unknown fields and executable material such as transactions, calldata, signatures, instructions, submission payloads, or broadcasts fail closed at any nesting depth. Receipts hash only the validated normalized response and identify the response schema used.

Every receipt fixes these safety facts:

- `executionAuthorized: false`
- `actionsExecuted: 0`
- `writesExecuted: 0`
- `transactionsExecuted: 0`

The API key is kept in a server-only closure. It is never accepted in an operation input, copied into a result, or included in a receipt.

## Server usage

```js
import { createJeffBankrReadOnlyAdapter } from 'jeff-agent-nft/bankr-readonly';

const bankr = createJeffBankrReadOnlyAdapter({
  apiKey: process.env.BANKR_API_KEY,
});

const portfolio = await bankr.getPortfolio({
  chains: ['base'],
  include: ['pnl'],
});

const quote = await bankr.getSwapQuote({
  fromChain: 'base',
  fromToken: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  toChain: 'base',
  toToken: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  amount: '0.01',
  slippageBps: 100,
});
```

Never expose this adapter directly to a browser. Run it on a trusted server and return only the minimum data required by the caller.

## Required Bankr account controls

Before connecting a real key:

1. Create a dedicated Bankr account and wallet for JEFF.
2. Enable read-only mode.
3. Restrict the key to known server egress IPs.
4. Disable Agent API and token-launch access unless separately approved.
5. Keep the wallet empty during read-only integration testing.
6. Store the key only in the deployment secret manager.

Bankr creates new keys with write access enabled by default. Do not connect a new key until read-only mode and the other restrictions have been verified in the Bankr dashboard.

## Explicit non-goals

This adapter does not connect to `POST /wallet/swap`, `/wallet/transfer`, `/wallet/sign`, `/wallet/submit`, `/wallet/x402-pay`, `/agent/prompt`, or token-launch endpoints. A future write adapter must be a separate module and release. It must bind a JEFF execution intent to owner policy, simulation, fresh authorization, quotas, durable idempotency, emergency stop, restricted recipients, and final-state receipts.

## Sources

- Bankr Wallet API: https://docs.bankr.bot/wallet-api/overview/
- Bankr Portfolio API: https://docs.bankr.bot/wallet-api/portfolio/
- Bankr API-key controls: https://docs.bankr.bot/security/developer-api/
- Bankr OpenAPI: https://docs.bankr.bot/openapi/api.yaml
