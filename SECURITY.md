# Security policy

## Supported version

Security fixes target the latest released JEFF checkpoint and runtime.

## Report a vulnerability

Do not open a public issue for a vulnerability that could expose secrets, private memory, owner policy, or transaction authority. Use GitHub private vulnerability reporting for this repository.

Include the affected file or version, reproduction steps, impact, and any proposed mitigation. Do not include live private keys, seed phrases, signatures, API credentials, or private user data.

## Runtime boundary

JEFF v0.5 is a shadow decision model. It must not sign, submit, publish, spend, change permissions, or execute transactions. Integrations must preserve `executionAuthorized: false` and apply their own independently reviewed policy and execution controls.
