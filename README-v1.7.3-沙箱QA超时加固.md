# Asterline Node v1.7.3 — Sandboxie QA and Timeout Hardening

## What changed

1. Restored `scripts/qa/unit.test.mjs`, `scripts/qa/sandbox-os-probe.mjs`, and `examples/qa/` (`probe`, pinned `zod`, intentionally long-running `hang` fixtures, plus a **sample** Sandboxie.ini). `QA-Run.ps1` now has the files its existing entrypoint references.
2. Added `scripts/qa/check-sandbox-policy.mjs` (read-only check of **actual Sandboxie.ini**) and paired **host-positive-control + sandbox-negative-control** checks: sensitive QA file read, host file persistence, loopback TCP, loopback UDP, external non-loopback TCP. Probe only attempts a TCP connection to the external host, without transferring application data.
3. Timeout now has its own `timedOut` boolean, and plugin run is recorded as `timed_out`. When the time limit fires, Asterline issues `Start.exe /box:<BOX> /terminate`, then calls `/listpids` repeatedly to ensure no PIDs remain. It also checks the box for surviving processes after a normal launcher exit. A stale/non-empty box before execution fails closed. Unverified cleanup writes `sandbox-interlock-<BOX>.json` in the Node data directory, blocking further sandbox calls until a human investigates.
4. QA runtime scratch uses a unique per-run directory so previous QA artifacts do not block future tests. No changes to Cloudflare or administrator grants.

**The package does not edit the user's Sandboxie.ini or change the production sandbox policy.** The administrator must manually apply QA settings and run live probes on Windows.

## Installation (existing v1.7.2)

Stop Asterline Node, back up project and `.state-node`, extract the **upgrade** ZIP into `C:\Users\YourName\Desktop\AsterlineNode`, preserving `.env` and database. Start it after tests.

```powershell
cd C:\Users\YourName\Desktop\AsterlineNode
pnpm run check
pnpm test
pnpm run qa:unit
```

The `qa:unit` suite runs without npm downloads or Sandboxie. Staging and `--online` still require installed dependencies and respectively a working local server / official npm registry.

## Harden AsterlineQATest (manual one-time operation)

Open Sandboxie Plus → AsterlineQATest → Sandbox Options. Stop every running QA sandbox process first. Under **Recovery**, disable *Immediate Recovery* (`AutoRecover=n`). Under **Network**, turn off internet access for all processes, including loopback; enable WFP filtering if supported; block access to network shares. In **Edit ini Section**, confirm settings for the **QA box only**:

```ini
[AsterlineQATest]
AutoRecover=n
BlockNetworkFiles=y
AllowNetworkAccess=n
NetworkAccess=*,Block
BlockLocalLoop=y
ClosedFilePath=C:\Users\YourName\AsterlineQA_Private\
```

In the real Sandboxie.ini, under `[GlobalSettings]`, ensure `NetworkEnableWFP=y`. This is **global**, not a box setting; review the effect on other sandboxes first. Sandboxie Plus 1.17.4 or later supports `BlockLocalLoop`. Remove any conflicting network allow/exception rules for this box. Do not add `OpenFilePath`/Direct Access to the project, user profile, or recovery directories. No administrator-approved data should be automatically recovered from an untrusted plugin.

**Important:** `BlockNetworkFiles=y` only limits UNC/network file shares; it is **not** a TCP/UDP firewall. Static INI checks do not prove the running service applied your settings or cover every Windows IPC/network route. The runtime probe exercises representative paths, not a formal security proof. Using privacy/hardened Sandboxie modes and a non-admin Windows account is still recommended.

For a read-only static check, locate the **real** Sandboxie.ini (NOT SandMan.ini). If uncertain, use Sandboxie Plus's Edit ini function to locate the configuration file.

```powershell
$env:QA_SANDBOX_INI = 'C:\Windows\Sandboxie.ini'  # replace with your real location
node scripts/qa/check-sandbox-policy.mjs
```

The static checker deliberately fails if AutoRecover is on, WFP is missing, loopback/network denial is missing, or known allow rules conflict. A template file `examples/qa/AsterlineQATest.sandboxie.ini` is provided as a **reference only**. Do not overwrite the system ini with it.

## Live QA on Windows (after policy review)

```powershell
$env:QA_SANDBOX_ROOT = 'C:\Sandbox\YourName\AsterlineQATest' # actual FileRootPath
$env:QA_SANDBOX_BOX = 'AsterlineQATest'
$env:QA_POLICY_CONFIRMED = '1'
# Non-loopback destination MUST be reachable from host, otherwise test fails inconclusively.
$env:QA_EXTERNAL_HOST = '1.1.1.1'
$env:QA_EXTERNAL_PORT = '443'
.\QA-Run.ps1 -Mode sandbox -Sandbox
Remove-Item Env:\QA_POLICY_CONFIRMED,Env:\QA_SANDBOX_ROOT,Env:\QA_SANDBOX_BOX,Env:\QA_SANDBOX_INI,Env:\QA_EXTERNAL_HOST,Env:\QA_EXTERNAL_PORT -ErrorAction SilentlyContinue
```

You should see PASS for **static QA policy**, **non-loopback positive control**, **Sandboxie OS-only isolation**, and **real Node plugin worker**, and **real 3-second worker timeout followed by empty sandbox PID verification**. The latter intentionally starts a QA-only 30-second idle worker and kills the QA sandbox after 3 seconds; do not share AsterlineQATest with unrelated processes. `SANDBOX_POLICY_CONFIRMED=0` in the production `.env` stays unchanged. Because the test invokes a real TCP connection to the chosen external host, choose only endpoints you are authorized to probe.

## Verify timeout cleanup / repair interlock

The runner uses a **dedicated named Sandboxie box**; termination affects all processes **inside that box**. Never share it with ordinary desktop processes or another job. To inspect PIDs manually:

```powershell
& 'C:\Program Files\Sandboxie-Plus\Start.exe' /box:AsterlineQATest /listpids | more
```

The first line is the process count; after timeout it must be `0`. If Asterline reports `cleanup NOT VERIFIED` or creates a `sandbox-interlock-<BOX>.json`, do **not** enable production plugin execution, blindly delete it, or grant Direct Access. Review Sandboxie UI, verify no processes remain, determine why cleanup failed, and only then manually remove the specific interlock for the relevant Node data directory.

**Known limitations:** The CI/container test runner is not Windows and does not have a running Sandboxie driver; it can verify JS logic and mocked `/listpids`/`/terminate` responses but cannot claim WFP enforcement or real child-process cleanup. Live Windows QA and any prior installed app/service behavior require separate acceptance.

## Sources

- Sandboxie [Start.exe command line](https://sandboxie-plus.github.io/sandboxie-docs/Content/StartCommandLine/): `/listpids`, `/terminate`, `/wait`.
- Sandboxie [AutoRecover](https://sandboxie-plus.github.io/sandboxie-docs/Content/AutoRecover/): immediate recovery.
- Sandboxie [BlockNetworkFiles](https://sandboxie-plus.github.io/sandboxie-docs/Content/BlockNetworkFiles/): network shares, not a full firewall.
- Sandboxie [BlockLocalLoop](https://sandboxie-plus.github.io/sandboxie-docs/Content/BlockLocalLoop.html): loopback coverage and limitations.
