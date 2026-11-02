# 009 Windows

The plugin runs on Windows 10 and 11 with the desktop build of DeepSeek Harness. The sources, the Engine, the Executor and the panel behave as [006 Deployment](006-deployment.md) describes; this document lists what the operating system changes, how to start the service there, and what does not work the same way.

## What it needs

| Requirement | Why |
| --- | --- |
| The desktop build of DeepSeek Harness, 0.2.1-rc.x or later | The plugin is a profile bundle; the desktop build is the only Windows distribution, and `scripts/dsh-superagent.cmd` starts its executable directly |
| Git for Windows, 2.32 or later | The worker environment writes a shared git configuration with a credential helper and checks it on startup |
| `gh.exe` (GitHub CLI), or a wrapper of your own | The GitHub Source runs setup and every read as that account; keep the wrapper's absolute path |
| PowerShell 5.1 or PowerShell 7, or `bash` | A ticket's prepare command runs in the first shell found: `pwsh`, `powershell`, `bash`, then `cmd` |
| A dedicated DSH profile | The plugin changes its process's `PATH` and git environment, so it must not load in `desktop` or any other profile in use |

Node is not required separately: the launcher runs the Node that ships with DeepSeek Harness, and the CLI shim sets it up.

## What differs from POSIX

- **Command shims are batch files.** The worker directory holds `gh.cmd`, `git.cmd` and, when Feishu is configured, `lark-cli.cmd`. `git` and `gh` resolve through `PATHEXT`, so a configured CLI may be named without its extension.
- **Prepare commands run in a Windows shell.** `sh -c` would fail on a machine without it, so the Executor picks `pwsh`, `powershell`, `bash`, or `%ComSpec%` and passes the command as written; write the command for the shell that will run it.
- **The credential helper uses forward slashes.** A git configuration normalizes native paths to `C:/…` before git reads them, so the helper in the worker git configuration is spelled that way on both platforms.
- **`stateDir` takes a drive or UNC path.** `C:\Users\<you>\.dsh\state\superagent` and `\\server\share\superagent` are accepted; the path must still be absolute for this machine, and it must not be relative.
- **There is no tmux.** `start` runs the service as a detached process with one log file instead of a tmux pane, so nothing reuses a session window, and `status` finds the process through `Get-CimInstance` rather than `ps`.

## Configure the sources

Create the profile, then write the source configuration as in [006 Deployment](006-deployment.md), with Windows values:

```yaml
# C:\Users\<you>\.dsh\profiles\superagent\cordis.patch.yml
- id: webserver
  config:
    host: 127.0.0.1
    port: 3082
- id: dsh-superagent
  config:
    stateDir: C:/Users/<you>/.dsh/state/superagent
```

The GitHub Source's `cli` field takes either a bare command name, which setup resolves through `PATH` with the worker shim directory removed, or the absolute path of `gh.exe` or of a wrapper batch file.

## Run the service

```
scripts\dsh-superagent.cmd start
scripts\dsh-superagent.cmd status
scripts\dsh-superagent.cmd stop
scripts\dsh-superagent.cmd restart
```

The subcommands, options, exit codes, control directory and log names are those of the POSIX launcher: `0` while the service runs normally, `1` when it is stopped, duplicated, unreachable or reporting a runtime error, `2` when a component such as a Source reports an error that only a person fixes, and `3` while it waits for setup. `--profile`, `--url`, `--timeout`, `--stop-timeout` and `--respect-stop` mean the same thing, and the defaults are the profile `superagent` and the URL `http://127.0.0.1:3082`.

Logs go to `.artifacts\dsh-superagent-<profile>-<date>-<time>-<pid>.log`, twenty kept per profile, and `start` prints the path.

## Stopping on Windows

A desktop executable has no console to receive `SIGINT`, so `stop` takes three steps:

1. it asks the management API to pause the Executor, so no new work starts;
2. it waits until no Executor Session runs, up to `--stop-timeout` (300 seconds by default), so a worker finishes its step;
3. it ends the process tree with `taskkill /PID <pid> /T /F`.

A drain that does not finish in time leaves the process running, keeps the manual stop marker and exits `1`, exactly like a graceful stop that timed out on POSIX. `restart` stops without writing that marker, so an intentional stop is the only thing that keeps automatic recovery off.

## Troubleshooting

| Message | Fix |
| --- | --- |
| `dsh must be on PATH (the desktop CLI shim dsh.cmd), and its executable must exist.` | Install the desktop build, or add its `runtime\cli\bin` directory to `PATH` |
| `dsh-superagent configuration needs a stateDir that is absolute on this platform` | Use a drive or UNC path; a POSIX path such as `/var/lib/superagent` is not absolute here |
| `The prepare command failed: …` | The command must run in the shell that `prepareShell` picks; a POSIX-only command needs `bash` on `PATH` |
| `GitHub CLI in the Source settings is not an executable file` | Give the absolute path of `gh.exe` or of your wrapper batch file |
| `setup.stages` reports `gitTooOld` | Upgrade Git for Windows to 2.32 or later |
| `Multiple dsh-superagent processes found` | Stop the extra instance yourself; the launcher never picks one of several |
