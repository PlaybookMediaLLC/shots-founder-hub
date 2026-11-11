# Setup

## Choose local or Cloud access

On the user's computer, prefer the local CLI or local MCP. Local access works without Cloud login, a Pro subscription, or completed Cloud Sync. On a remote agent without that database, connect Cloud MCP through OAuth.

Cloud Sync is encrypted. **Cloud API & Connectors** separately uploads readable snapshots after explicit opt-in. Its upload state is independent of Cloud Sync; OAuth does not decrypt synced data.

## Cloud MCP

The Shots Founder Hub plugin connects to the hosted server:

```text
https://api.anarlog.so/mcp
```

Cloud access needs Pro access through a personal plan or an eligible paid Pro workspace membership. In the desktop app, open **Settings → Developers → Cloud API & Connectors**, review the disclosure, and enable it. Wait for meeting snapshots to upload. Use the host's connection control to sign in and approve OAuth; some MCP hosts prompt on first cloud tool use. No cloud API key or local CLI is required for Cloud reads. Installing the skill alone does not create an account connection.

## Local CLI

Prefer the local CLI with `--json` when its database is available, including when Cloud MCP is connected. Run `sfh --json doctor` to check readiness, then `sfh --json meetings --source local list`.

Open **Shots Founder Hub → Settings → Developers** and select **Install**. Direct-download builds install:

- macOS and Linux (DEB / AppImage): `~/.local/bin/sfh`
- Windows: `%LOCALAPPDATA%\Shots Founder Hub\bin\sfh.exe`

The Mac App Store build does not bundle CLI installation. Build from source instead.

To build from source instead:

```bash
git clone https://github.com/PlaybookMediaLLC/shots-founder-hub.git
cd shots-founder-hub
cargo install --locked --path apps/cli
sfh --version
```

Run the Shots Founder Hub desktop app once so its local database exists. The CLI works while the app is closed after that.

Cloud sign-in does not require a graphical session on the Shots Founder Hub machine. Run `sfh auth login`, open the printed URL in any browser, and paste the copied callback URL into the CLI prompt. Confirm the session with `sfh auth status`. With `--json`, the login URL is printed to stderr and the callback is read from stdin.

After login, `sfh --json meetings --source cloud list` reads the same hosted snapshots as Cloud MCP. `--source auto` uses the local database when it exists and Cloud only when it does not. It does not fall back for an empty search or a database error, and does not check sync or snapshot freshness. Use an explicit `--source local` or `--source cloud` to keep related reads on the same source.

The command is `sfh` on DEB, AppImage, Flatpak, macOS, Windows, and Settings-installed builds.

Homebrew, standalone release binaries, and Windows package-manager distribution are not yet available.

Use `--db-path FILE` or `ANARLOG_DB_PATH` only when the database is outside Shots Founder Hub's default application-data location.

## Optional local MCP

For an agent with local MCP support, start the stdio server yourself:

```bash
sfh mcp
```

A generic client configuration is:

```json
{
  "mcpServers": {
    "sfh": {
      "command": "sfh",
      "args": ["mcp"]
    }
  }
}
```

Restart the client after changing its MCP configuration. The marketplace plugin does not start this server.
