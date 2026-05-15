# Mac mini deploy

Run `npm run snap` as a 24/7 launchd agent so the camera-snap server is always
reachable from your phone.

## Prerequisites

- macOS (any version with launchd — i.e. all of them)
- The project has been cloned, `npm install` has been run, `.env` is filled in,
  and `npm run snap` works manually. (Run `npm run setup` first if not.)
- Supabase migrations have been pushed (`supabase db push`).

## Install

From the project root:

```bash
./deploy/install-launchd.sh
```

The script:

1. Resolves the absolute paths of your current `node` and `npm` binaries
   (so the agent works whether you use Homebrew, nvm, asdf, or whatever).
2. Substitutes those + the project directory into the plist template.
3. Writes the result to `~/Library/LaunchAgents/com.collectibles.snap.plist`.
4. Loads it via `launchctl`.

The agent starts immediately and re-launches on boot. Logs land at
`<project>/snap.log` and `<project>/snap.err.log`.

## Operate

```bash
# Tail logs
tail -f snap.log snap.err.log

# Restart (after a code change or .env edit)
launchctl kickstart -k gui/$UID/com.collectibles.snap

# Stop temporarily
launchctl unload ~/Library/LaunchAgents/com.collectibles.snap.plist

# Status
launchctl list | grep com.collectibles.snap
```

After `git pull`, run `launchctl kickstart -k gui/$UID/com.collectibles.snap`
to pick up the new code. (`npm run snap` uses `tsx` so there's no build step.)

## First-run gotchas

- **Firewall prompt**: macOS pops "Allow incoming connections?" for the node
  process on port 3457. If you're running headless and miss the prompt, the
  server silently binds to localhost only. Pre-approve via System Settings →
  Network → Firewall → Options → add `node` and allow incoming.
- **Reserved IP**: set a DHCP reservation on your router so the mini's LAN IP
  doesn't drift. The phone URL is hardcoded to that IP at print time.
- **Remote access**: easiest is Tailscale — install on the mini and your phone,
  then use `http://<mini-tailscale-name>:3457` from anywhere. No port forward,
  no Cloudflare Tunnel needed.

## Switching Node versions

If you `nvm install` a new Node, re-run `./deploy/install-launchd.sh` so the
plist picks up the new node binary. Otherwise the agent will keep launching
the old version.

## Removing the agent

```bash
launchctl unload ~/Library/LaunchAgents/com.collectibles.snap.plist
rm ~/Library/LaunchAgents/com.collectibles.snap.plist
```
