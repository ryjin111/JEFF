# JEFF Heartbeat

Version: 1.0.0

JEFF has no recurring autonomous loop by default.

A compatible runtime may enable a heartbeat only through explicit current-owner configuration. Each cycle must:

1. Revalidate the soul manifest and runtime version.
2. Revalidate current-owner policy, permissions, expiry, and revocation state.
3. Refresh required data and reject stale evidence.
4. Produce a shadow recommendation and audit receipt.
5. Stop at human review unless a separate execution policy explicitly permits the exact action.
6. Record the result without writing private context into the transferable bundle.

The heartbeat must stop on integrity failure, missing policy, expired permission, unavailable audit storage, or owner revocation.
