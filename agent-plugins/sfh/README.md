# Shots Founder Hub agent plugin

Query Shots Founder Hub meetings with a local-first skill and an optional Cloud MCP connection. On your computer, the skill prefers the local CLI or local MCP, including unsynced changes. Remote agents use OAuth-connected Cloud snapshots. Read notes, summaries, participants, action items, bounded transcript excerpts, recurring history, and complete exports when explicitly needed.

## Local access

Install the [Shots Founder Hub CLI](https://shots.playbookmedia.io/docs) and open the desktop app once to create its database. Run `sfh --json doctor`, then `sfh --json meetings --source local list`. Local reads need no Cloud login, Pro subscription, or completed sync. The app can be closed after its database exists.

## Optional Cloud access

1. Sign in with Pro access through a personal plan or an eligible paid Team membership in the desktop app.
2. Open **Settings → Developers → Cloud API & Connectors**, review the disclosure, and enable it.
3. Wait for your meeting snapshots to upload.

Use the host's connection control to sign in and approve OAuth. Some MCP hosts prompt on first cloud tool use. The host discovers Shots Founder Hub's authorization server from `https://api.anarlog.so/mcp`; no cloud API key is required.

The CLI can also read hosted snapshots with `sfh meetings --source cloud ...` after login. `--source auto` prefers the local database and uses Cloud only when it is absent; it does not check freshness or hide database errors.

The repository package is named **Shots Founder Hub**. Its optional hosted connection appears as **Shots Founder Hub Cloud**.

## Install from this repository

### Claude Code

```bash
claude plugin marketplace add PlaybookMediaLLC/shots-founder-hub
claude plugin install sfh@playbook
```

Or add the remote server directly. Claude discovers OAuth from the MCP endpoint:

```bash
claude mcp add --transport http sfh https://api.anarlog.so/mcp
```

### GitHub Copilot CLI

```bash
copilot plugin marketplace add PlaybookMediaLLC/shots-founder-hub
copilot plugin install sfh@playbook
```

### ChatGPT and Codex

```bash
codex plugin marketplace add PlaybookMediaLLC/shots-founder-hub \
  --sparse .agents/plugins \
  --sparse agent-plugins/sfh
```

Restart the ChatGPT desktop app, open the Plugins Directory, select the Playbook source, and install **Shots Founder Hub**.

The plugin includes an optional **Shots Founder Hub Cloud** App connection. Connect it for hosted access; leave it disconnected to use the local CLI. The public directory listing has its own review and release process, separate from this repository marketplace.

### Cursor

Import `https://github.com/PlaybookMediaLLC/shots-founder-hub` as a team marketplace, then install **Shots Founder Hub**. You can also load `agent-plugins/sfh` as a local plugin while testing.

## Configure MCP directly

Clients that do not install plugins can add the hosted server:

```json
{
  "mcpServers": {
    "sfh": {
      "url": "https://api.anarlog.so/mcp"
    }
  }
}
```

For a fully local agent that should not use Cloud, start `sfh mcp` yourself. See [MCP for agents](https://shots.playbookmedia.io/docs). Static remote clients that cannot complete MCP OAuth can follow the [remote MCP setup](https://shots.playbookmedia.io/docs) with a cloud API key.

## Data access

Cloud MCP is read-only hosted snapshots. Local CLI and optional local MCP read the app database through Shots Founder Hub's compatibility layer. Cloud access uploads a separate server-readable copy only after the user opts in. Encrypted Cloud Sync and connector uploads have independent freshness; neither database availability nor a meeting's `updated_at` proves that all copies are current. See [Data, privacy, and retention](https://shots.playbookmedia.io/docs).
