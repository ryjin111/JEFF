# Public staging monitoring

The Windows task **JEFF staging public monitor** checks the staging site every five minutes. It runs a hidden PowerShell action under the current user's **Interactive / Limited** principal; it uses no SYSTEM identity, stored account password or provider key. The task was registered and a scheduled invocation completed successfully on 9 October 2026, at approximately **17:44 Asia/Taipei**.

This is a workstation monitor. The computer must be on and the current user must be logged in. It writes a local report and Task Scheduler exit status; it sends no email, Discord, Slack or other outside notification. An independently hosted monitor with an approved alert destination remains necessary for unattended production coverage. No additional cloud service or paid monitoring plan was provisioned.

## What it checks

`scripts/uptime-monitor.mjs` performs three requests, with at most three in flight:

1. `GET /health`: JEFF reports ready and its expected execution runtime.
2. `GET /api/config`: JEFF reports the expected source, chain, collection, real hosted configuration and configured model; fixtures, unexpected enabled tools and a restore guard are failures.
3. A public JSON-RPC batch containing only `eth_chainId` and `eth_blockNumber`: the endpoint responds with the expected chain and a valid block number.

Requests have an eight-second timeout, disabled redirects and a 64 KiB response limit. No holder session, private workspace, wallet signature, model request, token payment or transaction is used. Reports retain only check status, timing, public release identity and chain/block metadata. RPC credentials, paths, query strings, response bodies and upstream error messages are excluded from reports. The RPC check comes from the workstation; it does not prove the application's Railway egress can complete a holder ownership check.

One failed sample sets process exit code 1. Three consecutive failed samples set `alertActive: true` in the report; a healthy sample clears it. Internal/configuration errors exit 2. At most 288 samples are retained. This is a local fault indicator, without outside alert delivery. A missing or stale report is itself a monitoring failure, even when the last saved sample was healthy.

Railway's deployment health check runs at deployment time; it does not provide continuous runtime monitoring. [Railway health checks](https://docs.railway.com/deployments/healthchecks)

## Local operation

Private configuration: `.private/staging-monitor.json`.

Current report: `evidence/staging/monitor-latest.json`.

Task readback and successful invocation: `evidence/staging/monitor-task-receipt.json`.

The task uses portable Node 24.21.0 and `IgnoreNew` to prevent overlap, a one-minute execution limit and a five-minute indefinite repetition interval. It does not wake a sleeping computer. Its source pin must be updated in the private configuration after an intentional staging release; otherwise source drift correctly fails the check.

Run a single check from the project folder:

```powershell
& 'D:\agentmanagerworks\tools\node-v24.21.0-win-x64\node.exe' scripts/uptime-monitor.mjs --config .private/staging-monitor.json
Get-ScheduledTaskInfo -TaskName 'JEFF staging public monitor'
```

The task can be disabled reversibly with `Disable-ScheduledTask -TaskName 'JEFF staging public monitor'` and enabled with the matching `Enable-ScheduledTask` command. Keep configuration and report files out of the Git repository.

## Bounded reachability sample

Four rounds completed successfully on 9 October 2026, at approximately **17:44 Asia/Taipei**, using 12 requests total and at most three concurrent requests. Staging was on source `2ff9a919006a8ade4c95fe45fe1f984fdbae8b3a`; RPC was `robinhood-rpc.publicnode.com`.

| Public check | Samples | Minimum | Median | Maximum |
| --- | --- | --- | --- | --- |
| Staging health | 4 | 212 ms | 222 ms | 352 ms |
| Staging configuration | 4 | 211 ms | 255.5 ms | 301 ms |
| RPC chain/block batch | 4 | 204 ms | 207.5 ms | 263 ms |

Evidence: `evidence/staging/public-reachability-sample.json`. These are short reachability observations from one machine, not measured production throughput, a load test, provider capacity or an uptime SLA. No inference calls or holder work were used.

A separate read-only Railway resource summary for the five-minute window ending around **17:49 Asia/Taipei** reported approximately 63.8 MB memory, 915.2 MB used on `/data`, and 0.00052 vCPU peak. This was an idle baseline without model generation. Provider-reported resource ceilings are configuration, not demonstrated throughput. The returned aggregate metrics, without holder data, are saved in `evidence/staging/monitor-resource-baseline.json`.

## Production capacity gates

The application currently limits active jobs to two across the service. That configuration does not establish how many holders it can serve. Before a broader launch:

- Validate a dedicated RPC endpoint and its documented request quota from Railway egress; recheck chain, collection, fresh pinned-block owner and epoch reads. Preserve fail-closed behavior during rate limits and outages. Robinhood recommends a provider-backed endpoint for production. [Robinhood connection guide](https://docs.robinhood.com/chain/connecting/)
- Measure real admission, completion and queue/rejection latency using explicitly authorized pilot work, with the current two-job limit. Verify failure behavior and task/monetary accounting before changing that limit.
- Record CPU, resident memory, process restarts, volume growth/free capacity and provider billing capacity during that work. Include saved job and schedule history growth. Public health/config timing does not cover these measurements.
- Run an independent always-on monitor with an approved destination and test its failure/recovery notification. This workstation task does not satisfy that gate while the machine is off or logged out.
- Keep one writer on the persistent volume. Railway does not support service replicas with a volume, and a volume-backed deployment has a brief interruption. [Railway volumes](https://docs.railway.com/volumes/reference)
