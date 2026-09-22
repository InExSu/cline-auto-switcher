# cline-account-switcher

Automatically switches Cline accounts when the rate limit for **the model you are
using** is exhausted — then resumes the task on the new account.

No proxy, no router, no fork of Cline. It hooks into Cline's own `TaskError`
event and rewrites the credential block Cline already reads.

## How it works

Cline fires a hook on every task error. This project installs a hook file named
`TaskError` into Cline's hooks directory. The entire contract below was read out
of the installed `@cline/core` / `@cline/shared` v3.0.62 bundles:

| Piece | Verified detail |
| --- | --- |
| Hook file name | `TaskError` maps to the `agent_error` event |
| Hook location | `<clineDir>/hooks` — i.e. `~/.cline/hooks` |
| Interpreter | extension `.mjs` is spawned as `node <path>` (works on Windows) |
| Input | event payload as JSON on **stdin** |
| Output | Cline `JSON.parse`s the **whole stdout** into a control object |
| Credentials | `resolveProviderSettingsPath()` → `$CLINE_PROVIDER_SETTINGS_PATH` ?? `~/.cline/data/settings/providers.json` |
| Account block | `providers.cline.settings.auth` = `{ accessToken, refreshToken, expiresAt, accountId, … }` |
| Token refresh | Cline refreshes from `refreshToken` itself (5-minute buffer) |

Because Cline parses stdout as JSON, the hook writes **only** the final control
object there and sends every diagnostic to stderr and a log file. Anything else
would make Cline silently discard the control object.

### The switch

```
rate limit (429 / "rate limit" / "quota exceeded" / "resource exhausted")
   |
   +- classify  -- uses Cline's own RATE_LIMIT_PATTERNS, so we react to exactly
   |               what Cline considers a limit
   +- park      -- cooldown recorded per (account, MODEL), not per account
   +- pick      -- next account with no cooldown for that model
   +- write     -- swap providers.cline.settings.auth, everything else preserved
   +- marker    -- so `cline-switch run` can resume the session automatically
```

**Per-model cooldowns are the important part.** Limits are usually per model, so
an account throttled on one model stays usable for another. A cooldown is keyed
`account::model`; `account::*` means the whole account is limited.

## Install

```powershell
cd C:\account-switcher
node bin/switch.mjs init
```

## Enrol your accounts

Repeat for each Cline account you own:

```powershell
cline auth                                    # sign in (OAuth) as account 1
node bin/switch.mjs capture --label personal
cline auth                                    # sign in as account 2
node bin/switch.mjs capture --label work
```

`capture` snapshots the `settings.auth` block out of `providers.json` into the
vault (`~/.cline-account-switcher/accounts.json`). Storing the `refreshToken` is
enough — Cline keeps the access token fresh on its own.

Then activate the hook:

```powershell
node bin/switch.mjs install-hook
```

## Daily use

```powershell
node bin/switch.mjs status     # accounts, live model, who is cooling for what
node bin/switch.mjs use work   # switch right now
node bin/switch.mjs rotate     # force a switch to the next healthy account
node bin/switch.mjs reset      # clear all cooldowns
```

## Dashboard

The CLI covers everything, but the dashboard makes day-to-day use one click:

```powershell
node bin/switch.mjs serve            # http://127.0.0.1:4317/ (opens a browser)
node bin/switch.mjs serve --port 5000
node bin/switch.mjs serve --no-open
```

For a look without signing anything in, the demo seeds three fake accounts
(one in use, one cooling, one out of credits) into a sandbox under `%TEMP%` and
serves the dashboard from it:

```powershell
node demo/seed-demo.mjs --serve      # http://127.0.0.1:4318/
```

What it shows:

- every pooled account, with the live one marked and per-model cooldown
  countdowns ticking in real time (including the "out of credits" terminal park)
- **add an account** — sign-in via Cline's own device flow (WorkOS AuthKit,
  fronts Google): a code is shown, you approve it in the browser, and the
  account lands in the vault. No `cline auth` dance, no callback server.
- **rotate** / **clear cooldowns** — the same as `rotate` and `reset` on the CLI
- **use** / **remove** per row — same as `use` and `remove`

Security model: the server binds to `127.0.0.1` only, mints a per-session
random token that is injected into the page (all API calls must send it as
`x-switcher-token`), and rejects cross-origin browser requests with an Origin
check. Any other process on the machine — or any web page you have open — gets
a 403. The API never serves the vault file itself, only status and actions.

Environment overrides all still apply (`ACCOUNT_SWITCHER_HOME`,
`CLINE_PROVIDER_SETTINGS_PATH`, `CLINE_HOOKS_DIR`), and `CLINE_CORE_PATH`
points at `@cline/core`'s `dist/index.js` if the CLI isn't installed the usual
way — the sign-in flow imports Cline's real device-auth code from it, lazily,
on the first click.

A guard in `vault.mjs` refuses to write obviously synthetic credentials
(`@example.com` emails, `refresh-acct-*` tokens) when no sandbox override is
set, so demo seeding can never clobber the real Cline auth block — it fails
loudly instead.

### Fully automatic

Wrap the task in the supervisor. It runs Cline, and whenever the hook switched
accounts mid-task it resumes the same session on the new account:

```powershell
node bin/switch.mjs run -- -p "refactor the auth module"
```

If you run plain `cline` instead, the hook still switches the account — you just
re-run the task yourself to pick up the new one.

## Commands

| Command | Purpose |
| --- | --- |
| `init` | Create the switcher home directory |
| `capture [--label L]` | Save the account currently in `providers.json` |
| `install-hook` / `uninstall-hook` | Add or remove Cline's `TaskError` hook |
| `status` | Accounts, live model, cooldowns |
| `accounts` | List pooled accounts |
| `use <id>` | Switch to a specific account |
| `rotate` | Force a switch to the next healthy account |
| `remove <id>` | Drop an account from the vault |
| `reset [<id>]` | Clear cooldowns |
| `run -- <cline args>` | Run Cline with automatic resume-after-switch |
| `serve` | Dashboard UI at `http://127.0.0.1:4317/` (`--port`, `--no-open`) |
| `config [key value]` | Show or set options |
| `check [message]` | Explain how a message would be classified |
| `where` | Print every path in use |

## Configuration

```powershell
node bin/switch.mjs config                       # show all options
node bin/switch.mjs config baseCooldownMs 120000
```

| Key | Default | Meaning |
| --- | --- | --- |
| `providerId` | `cline` | Which provider entry in `providers.json` is pooled |
| `baseCooldownMs` | `60000` | First cooldown after one 429 |
| `maxCooldownMs` | `3600000` | Ceiling for exponential backoff |
| `terminalCooldownMs` | `86400000` | Parking time for out-of-credits accounts |
| `hookOutput` | `silent` | `silent`, or `context` to inject a note for the agent |
| `maxAttempts` | `5` | Auto-resumes performed by `run` |
| `continuePrompt` | `continue` | Prompt used when resuming |

## Environment variables

Honoured the same way the Cline CLI honours them:

`CLINE_DIR`, `CLINE_DATA_DIR`, `CLINE_PROVIDER_SETTINGS_PATH`,
`CLINE_HOOKS_DIR`, `ACCOUNT_SWITCHER_HOME`, `CLINE_BIN` (supervisor target),
`ACCOUNT_SWITCHER_QUIET` (suppress stderr logging).

## Error classification

| Kind | Trigger | Rotates? | Cooldown |
| --- | --- | --- | --- |
| `rate_limit` | 429 / rate limit / too many requests / quota exceeded / resource exhausted | yes | exponential |
| `spend_limit` | `SPEND_LIMIT_EXCEEDED` (429, org budget cap) | yes | exponential |
| `quota_exceeded` | `INFERENCE_CAP_ERROR` | yes | exponential |
| `credits` | `insufficient_credits`, `not enough credits` | yes | terminal (24h) |
| `auth` | `requires re-authentication`, `invalid_grant`, `unauthorized` | **no** | — |

Auth failures deliberately do **not** rotate: moving a dead token to another slot
hides the real cause and can log you out.

## Tests

```powershell
node --test
```

28 tests: 16 switcher/hook/CLI, 11 dashboard, plus a regression test for the
demo-data guard in `vault.mjs`. The integration tests install the hook into a sandbox
and spawn it as a real child process with JSON on stdin, reproducing Cline's
invocation exactly — including the assertion that stdout stays empty, because a
stray `console.log` would break Cline's control parsing.

## Caveats

- **Terms of service.** Rotating accounts to evade per-account free-tier limits
  is very likely against Cline's terms and risks bans. Rotating across accounts
  you legitimately own is the intended use.
- **Organisation-level caps.** `SPEND_LIMIT_EXCEEDED` is enforced per
  organisation, so a second account in the *same* org may hit the same wall.
- **A switch costs a retry.** The failed request is already lost; the supervisor
  resumes the session, but the in-flight turn is not replayed.
- **`run` needs to find `cline`.** It resolves `CLINE_BIN`, then
  `CLINE_WRAPPER_PATH`, then `node_modules/cline/bin/cline` on `PATH`. Set
  `CLINE_BIN` if your install is unusual.
- The vault stores refresh tokens in plaintext under your home directory
  (`chmod 600` on POSIX). Treat it like an SSH key.