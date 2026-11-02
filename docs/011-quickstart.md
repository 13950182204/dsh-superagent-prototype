# Quickstart: install dsh-superagent without disturbing DSH

Two ways to install. Both add the plugin to a DSH **profile**, and neither changes DSH itself: the plugin is ordinary
profile configuration, and removing it leaves the operator's own profiles byte for byte as they were.

## The quickstart installer

```sh
node scripts/install.mjs --from https://github.com/13950182204/dsh-superagent-prototype
```

The installer creates a profile named `superagent`, writes the plugin configuration into it, installs this checkout as a
linked plugin, and prints the command that runs the service. It uses the Node.js and pnpm that DSH already ships, so no
global install is needed. `--dry-run` prints every step first, `scripts/install.mjs doctor` re-checks an installation, and
`scripts/install.mjs uninstall` removes the profile and the state directory.

Because the service runs in its own profile, it may change its own process environment: worker Sessions inherit the agent's
`PATH`, isolated git configuration and command shims, and the operator's own sessions never see them. See
[Deployment](006-deployment.md) for the accounts, the GitHub and GitLab Sources, and the service manager.

## Adding the plugin from the DSH panel

DSH's *Add plugin* dialog accepts a package name, a GitHub repository, or a local directory. Adding this repository there
installs the plugin into whichever profile the panel serves — usually `desktop` or `web`, the profiles the operator also
works in.

That installation is deliberately **passive**:

- the Superagent sidebar and its management panel work, so the operator can see and fix the setup problems;
- no Source polls, no Ticket opens, and no worker Session runs, because the plugin will not change the environment of a
  profile it shares with the operator;
- the panel reports `sharedProfile` in the Source settings, with the profile's name.

`allowSharedProfile: true` in the plugin configuration turns the checks off, and is meant for a throwaway profile in a
container. Do not set it on the operator's own profile: worker Sessions inherit the environment the plugin prepares there.

## Which to choose

| | Quickstart installer | Panel install |
| --- | --- | --- |
| Profile | dedicated `superagent` | the panel's own profile |
| Sources, Tickets, workers | yes | no |
| Changes this process's environment | yes, in its own profile | never |
| Uninstall | `scripts/install.mjs uninstall` | remove the plugin in the panel |
