# 010 GitLab

Use this guide to run dsh-superagent against GitLab. It adds a Source that polls one project on gitlab.com or a self-hosted
server and turns what it reads into Triggers. Installation, machine configuration and service control stay in
[006 Deployment](006-deployment.md); [009 Windows](009-windows.md) covers the Windows differences. The GitHub Source is
unchanged, and both Sources can be on at once.

## What the Source does

The GitLab Source watches one project and turns new work into Triggers:

- new Issues;
- new merge requests;
- notes on Issues and merge requests, both conversation notes and inline diff notes;
- pipeline transitions, for a branch or a merge request.

Each item becomes a Trigger, and the Policy's Eval decides whether it starts a Ticket. Reading a Thread, through the panel
or the model-facing interfaces, does not create a Ticket.

GitLab has no notifications endpoint equivalent to GitHub's, so the Source cannot ask the account for its unread items. It
polls the configured project instead, and its state is project-scoped: an Issue or merge request in another project is
invisible to it.

With the observation switches off, which is the default, only what mentions the agent account arrives: a new Issue, merge
request or note that contains `@<account>`. Turning on a switch makes every matching item arrive, whether or not it mentions
the agent. Later notes on a Thread the Source has taken on arrive without another mention.

Issue and merge request numbers are separate spaces and map to different Threads:

| Observed | Thread |
| --- | --- |
| An Issue | `gitlab:issue:<iid>` |
| A merge request | `gitlab:mr:<iid>` |
| A note on either | The Issue's or merge request's own Thread |
| A pipeline for a branch | `gitlab:ci:<ref>` |
| A pipeline for a merge request | `gitlab:mr:<iid>` |

Issue 5 and merge request !5 therefore both exist, and replying to one does not answer the other.

## Requirements

| Item | Detail |
| --- | --- |
| GitLab server | 13.1 or later; tested with 13.1.4 Community Edition |
| Agent account | A dedicated account with at least Developer (access level 30) on the project. It reads the project and writes notes as itself |
| `glab` | 1.30 or later, on the worker's `PATH`; the Source relies on its subcommands and output |
| Wrapper | A script that pins `GLAB_CONFIG_DIR`, so `glab` can act only as the agent account |
| Node, git | As for the other Sources; see [006 Deployment](006-deployment.md) |

GitLab 13.1 Community Edition and later is supported; GitHub Enterprise Server remains unsupported, as
[006 Deployment](006-deployment.md) says. A project in a subgroup is fine, because `project` accepts a full path.

## Configuration

Enable the GitLab Source in the profile's `cordis.patch.yml`, as [006 Deployment](006-deployment.md) does for the optional
Feishu Source; the bundle ships it as its own plugin entry. Then set these fields on **Sources** in the panel, described in
[005 Panel](005-panel.md):

| Field | Meaning | Default |
| --- | --- | --- |
| `host` | The GitLab server's base URL, with its scheme and, when it is not the default, its port: `https://gitlab.com`, `http://192.168.11.238` or `http://192.168.11.238:8080`. A value without a scheme is read as `http://` | required |
| `project` | The project path GitLab shows, `namespace/path`; subgroups such as `platform/apps/widgets` are allowed | required |
| `cli` | The wrapper that runs `glab` as the agent account | required |
| `pollSeconds` | How often the Source polls, from 60 to 3600 | 60 |
| `failuresBeforeError` | Consecutive failed polls before the Source reports an error, from 1 to 20 | 3 |
| `observeIssues` | Receive every new Issue, not only ones that mention the agent | off |
| `observeMergeRequests` | Receive every new merge request | off |
| `observeComments` | Receive every new note on the project | off |
| `observePipelines` | Receive every pipeline transition | off |

The scheme in `host` is kept: the API is called at that address, so `http://` stays HTTP and does not become HTTPS, and the
port is kept too. For the public service, write `https://gitlab.com` in full rather than `gitlab.com`, which would be read
as HTTP.

Then under **Policy**, add the GitLab logins and bots who may ask for work to the Source's allowed list. Until a list has
someone, no request from GitLab can become a Ticket; see [002 Authorization](002-authorization.md).

## Register the CLI once

1. Create the agent's GitLab account and add it to the project with at least Developer (access level 30). Developer can
   read the project, open Issues and merge requests, and write notes; no higher role is needed.
2. Give the account its own `glab` configuration and wrapper, the same pattern [006 Deployment](006-deployment.md) uses
   for the GitHub account:

   ```sh
   mkdir -p ~/.local/bin
   cat > ~/.local/bin/glab-agent <<'EOF'
   #!/bin/sh
   GLAB_CONFIG_DIR="$HOME/.config/glab-agent" exec glab "$@"
   EOF
   chmod +x ~/.local/bin/glab-agent
   glab-agent auth login --hostname 192.168.11.238 --api-protocol http --git-protocol http
   glab-agent api user
   ```

   `auth login` prompts for a personal access token; with `--stdin` it reads the token from standard input. The token
   needs the `api` scope, and `write_repository` when workers push over HTTP. Pass `--api-protocol http` and
   `--git-protocol http` only for a server that speaks HTTP; leave them out for a server behind HTTPS. The last command
   prints the login the Source reports as the account.
3. Set `cli` on the GitLab card to the wrapper's absolute path, such as `/home/me/.local/bin/glab-agent`.

Setup writes a `glab` shim first on the worker `PATH` that runs this wrapper, and a credential entry for the server in the
worker git configuration. Workers therefore call `glab` and `git` by name and act only as the agent account.

The wrapper keeps the token in its own configuration directory. Never put the token in the profile, in `cordis.patch.yml`,
or in the plugin's state directory: a token there would be copied into backups and readable by every worker. Workers reach
GitLab through the agent account's `glab`, as they reach GitHub through `gh`.

## Threads and replies

An Issue and a merge request are different Threads. `gitlab:issue:<iid>` carries the Issue conversation; `gitlab:mr:<iid>`
carries the merge request, its pipeline and its inline diff discussions. A Ticket therefore answers where the request was
made, even when both numbers are 5.

A reply is posted as a note on the Issue or merge request, or, for an inline diff note, inside that discussion thread so it
stays attached to the diff line. The note carries an invisible marker, so a delivery retried after a failure does not post
it twice. Replies run as the agent account and appear under its name; the Source does not impersonate the person who asked.

## Execution variables

Prepare commands and Executor instructions receive these variables, with the same meanings as their GitHub counterparts in
[003 Execution](003-execution.md):

| Variable | Value |
| --- | --- |
| `DSH_SUPERAGENT_GITLAB_HOST` | The server the project is on, as configured in `host` |
| `DSH_SUPERAGENT_GITLAB_PROJECT` | The project path, `namespace/path` |
| `DSH_SUPERAGENT_GITLAB_ACCOUNT` | The agent account's login |
| `DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL` | The commit email a worker commits with |
| `DSH_SUPERAGENT_GITLAB_NUMBER` | The Issue or merge request that started the Ticket |
| `DSH_SUPERAGENT_GITLAB_MR_HEAD` | The merge request's head ref, when the Ticket came from a merge request |

The worker merges with `glab mr merge` when the Ticket's delivery policy allows it; [003 Execution](003-execution.md)
describes how Delivery requirements govern a merge. The plugin itself never merges a GitLab merge request: GitLab 13.1 has
no server-side auto-merge to enable, so the worker performs the merge explicitly, once, and reports the outcome.

## Prompts and the GitHub wording

The built-in prompts and Delivery requirements are written for GitHub, and its same text reaches every worker. A GitLab ticket
reads them through the `dsh-superagent-gitlab` skill, which says that `gh` is `glab`, a `gh pr …` command is a `glab mr …`
command, the `DSH_SUPERAGENT_GITHUB_*` variables are the `DSH_SUPERAGENT_GITLAB_*` ones, a pull request is a merge request
and an issue is an Issue. The merge CLI is `glab mr merge <iid> --yes`, and GitLab 13.1 Community Edition has neither
approvals nor auto-merge, so a person merges every merge request unless the Delivery requirements say otherwise. A team
that works only on GitLab may edit the team prompt sections to say so directly.

## Capability matrix on GitLab 13.1 CE

These are the server's own limits on Community Edition 13.1, not the Source's.

### Supported

| Capability | How the Source uses it |
| --- | --- |
| Issues and merge requests | List endpoints, filtered by `updated_after`, to find new and changed items |
| Conversation and inline notes | Note and discussion endpoints on both Issues and merge requests |
| Pipeline status | `pipeline` and `head_pipeline` on a merge request, and the pipeline list of a commit |
| Merge readiness | `merge_status` and `has_conflicts` on a merge request |
| Incremental polling | An `updated_after` cursor, so each poll reads the window since the last one |

### Not available on Community Edition

- **Approvals.** The approvals API returns 404 on CE, so approvals are never read and never gate a merge. Review approvals
  cannot block or allow a merge; do not wait for them.
- **`detailed_merge_status`.** CE does not report it, so the merge decision uses `merge_status` and `has_conflicts`.
- **Server-side auto-merge.** GitLab 13.1 has none. The plugin never merges a GitLab merge request automatically; the worker
  runs `glab mr merge <iid> --yes` when the Ticket's delivery policy allows it.

A merge is allowed only when the merge request is open, free of conflicts, and its pipeline passed, was skipped, or has not
run. `merge_status` and `has_conflicts` answer the first two conditions, `pipeline` or `head_pipeline` the third; an
approval state cannot enter the decision because it cannot be read.

### Slower than GitHub

GitLab 13.1 answers without ETag or 304, so every poll re-reads the Issues, merge requests and notes updated inside its
window instead of learning that nothing changed. Keep `pollSeconds` at 60 or more on a busy project, and consider turning
an observation switch off when the project sees more activity than one agent can act on.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `404` reading the project | `project` is not the path GitLab shows, or the agent account is not a member with Developer. Copy the path from the project's page, including subgroups |
| `403` from `glab` | The token expired, was revoked, or lacks the `api` scope. Sign in again with `glab-agent auth login` and update nothing else |
| `glab: command not found` in a Ticket | The wrapper is not on the worker's `PATH`. Set `cli` to the wrapper's absolute path, then run setup again |
| Pipeline status never arrives | The project runs no CI, or no pipeline ran for that branch or merge request. With `observePipelines` off, only pipelines on subscribed Threads are delivered |
| Notes are missing | The note is a `system: true` note: a label change, a push, a milestone edit or similar activity, not a message. Such notes never become Triggers |
| A mention does nothing | The author is not on the GitLab part of the Policy, the Source is off, or processing is paused. See [006 Deployment](006-deployment.md) |
| `status` exits 3 | Setup waits for the GitLab account, project or CLI. The overview links to the setting that fixes it; the `status` output names the missing part |

## What to check

1. The management API, as described in [006 Deployment](006-deployment.md):

   ```sh
   curl -s -H 'x-orchestrator-request: 1' http://127.0.0.1:3082/orchestrator/api/sources
   ```

   Each Source lists its `state` (`missing`, `off`, `error`, `setup`, `starting`, `paused` or `ready`), its `health`, its
   setup `problem`, the last day's `stats`, the Triggers it `filtered`, and the messages it `dropped` with a reason.

2. The panel's **Sources** tab: the GitLab card shows the same state and problem, and the fields above are editable there.

3. `scripts/dsh-superagent status`, which prints process ids, health and setup problems and exits 0 for normal operation,
   1 for a stopped or unhealthy service, 2 for a part such as a Source in error, and 3 while setup waits. On Windows, use
   `scripts\dsh-superagent.cmd` as [009 Windows](009-windows.md) describes.
