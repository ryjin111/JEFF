# JEFF Brain shadow HTTP API

The Brain HTTP route makes the complete Brain v1 reasoning loop callable while preserving its non-executing boundary. It accepts authenticated JSON requests, runs deterministic decisions, planning, critique, and tool supervision, then returns a verified hash-bound receipt.

The endpoint never calls a proposed tool. Every success and failure keeps execution disabled.

## Route

Deploy `api/jeff-brain.mjs` on a Node.js 20 or newer serverless runtime. The route is:

`https://your-domain.example/api/jeff-brain`

`GET` returns a minimal readiness response. `POST` requires a bearer token and an exact JSON envelope with one `request` field.

## Server configuration

- `JEFF_BRAIN_ACCESS_TOKEN`: required bearer token with at least 32 characters.
- `JEFF_BRAIN_MODEL`: required pinned planner model name.
- `JEFF_BRAIN_BASE_URL`: OpenAI-compatible model server. Defaults to `http://127.0.0.1:11434`.
- `JEFF_BRAIN_ALLOW_REMOTE`: must be exactly `true` to use a non-local model server.
- `JEFF_BRAIN_API_KEY`: optional server-side model credential. Never expose it to a browser or include it in a JEFF request.

Remote model use is denied by default. URL credentials are always rejected.

## Request

```bash
curl -X POST https://your-domain.example/api/jeff-brain \
  -H "Authorization: Bearer $JEFF_BRAIN_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{
    "request": {
      "objective": "Inspect verified policy and prepare a read-only report.",
      "state": {
        "proposal": "Inspect verified policy and prepare a read-only report.",
        "safetyFacts": {
          "authorized": true,
          "funded": true,
          "validTransition": true,
          "evidenceSufficient": true,
          "privacySafe": true,
          "validationSafe": true,
          "identityIntegrity": "trusted"
        },
        "requiredSafetyFactsComplete": true,
        "ownerPolicy": { "allowAutonomous": true }
      },
      "ownerPolicy": {
        "writeRequiresOwnerApproval": true,
        "allowedTools": ["policy.read"]
      },
      "tools": [{
        "name": "policy.read",
        "mode": "read_only",
        "description": "Read verified policy."
      }]
    }
  }'
```

The response contains `mode: "shadow"`, `executionAuthorized: false`, `actionsExecuted: 0`, supervised proposals, and a verified Brain receipt.

## Privileged context

The default environment route intentionally has no memory service or MCP authorization verifier. Requests containing those privileged context paths fail closed. A production integration may construct `createJeffBrainHttpHandler` with server-controlled memory and MCP dependencies after separate review.

The bearer token is an endpoint access control, not Agent NFT owner authorization. Durable memory, MCP context, feedback, execution, and wallet access keep their own independent authorization boundaries.

## Deployment controls

- Keep the model URL, model credential, and access token server-side.
- Apply platform rate limits and request timeouts.
- Keep request logging disabled or redacted because state may contain private context.
- Do not enable tool execution, writes, signing, broadcasting, spending, publishing, or training in this route.
- Run the full-stack shadow soak before launch.
