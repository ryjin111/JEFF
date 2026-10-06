# JEFF OpenClaw adapter

Import `createJeffOpenClawNftBridge` from `jeff-agent-nft/openclaw`.
Supply a data directory, a trusted on-chain owner and transfer-epoch resolver,
and an OpenClaw runner. Establish the wallet session outside the bridge.

The bridge validates a chain, collection, token, owner and transfer epoch scope;
rechecks it before and after every job; and saves the result in that scope's
private workspace. `retrieve(scope, jobId)` reads the saved result after restart,
checks its content hash, and revalidates ownership before returning it.

Transfer creates a new scope. The old owner's private results, model sessions,
credentials and permissions do not become the new owner's context. A return
transfer to the original wallet also requires a new transfer epoch.

For standalone hosting, import `createJeffOpenClawAccountBridge` from the same
entry point. Supply a trusted `resolveAccount(scope)` callback that returns true
only for a registered account. Authenticate the wallet session outside the bridge.
An account scope is `{kind:'account', chainId, owner}`. It has no collection, token
or transfer epoch and occupies a different workspace from every NFT scope, even
for the same wallet. Job execution, persistence, recovery and integrity checks
use the same storage implementation for both kinds of scope.

The companion `simple-jeff` product supplies wallet authentication, the Clockers
chain adapter and an actual OpenClaw CLI runner. Its initial pilot generates text
responses with external tools disabled. Paid hosting and continuous gateways are
separate service work. This adapter does not claim either capability is live.

Do not use browser-supplied ownership as a resolver, mount a shared workspace for
different epochs, or run multiple service processes against the same data root
without a distributed job lock.
