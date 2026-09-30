<div align="center">

# yazio-mcp

**An MCP server that lets AI assistants read and write your YAZIO food diary.**
<br>
Diary, nutrition history, body values, exercises and water, over the same private API the YAZIO app uses. Runs locally over stdio, no extra service.

[![CI](https://github.com/nichtlegacy/yazio-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/nichtlegacy/yazio-mcp/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/Node-20%2B-5FA04E?logo=nodedotjs&logoColor=white)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](tsconfig.json)
[![MCP SDK](https://img.shields.io/badge/MCP%20SDK-v2-111827)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[Overview](#overview) • [Tools](#tools) • [Quick start](#quick-start) • [Configuration](#configuration) • [Development](#development) • [API notes](docs/api-notes.md)

</div>

## Overview

YAZIO has no public API. This server wraps the private API of the mobile app so an
assistant like Claude can answer "how much protein did I eat this week?", log
"a bowl of skyr with blueberries" or record this morning's weight.

It is a fork of [fliptheweb/yazio-mcp](https://github.com/fliptheweb/yazio-mcp),
rewritten on the MCP TypeScript SDK v2 with its own API client. Every endpoint it uses
was verified against a real account; the findings are in
[docs/api-notes.md](docs/api-notes.md).

The project stays deliberately:

- **readable for a model** — diary entries come with names and calculated nutrients, not bare product ids.
- **small** — one bundled file, no runtime dependencies beyond Node.
- **careful with writes** — every write tool was tested as create, verify, delete, verify against the live API.
- **quiet about private data** — email, user token and payment ids never reach the model.

> Unofficial hobby project. Not affiliated with YAZIO — see [Disclaimer](#disclaimer).

## Tools

25 tools. Dates are local days (`YYYY-MM-DD`) and default to today.

| Area | Read | Write |
|---|---|---|
| Profile | `get_profile` | |
| Diary | `get_diary`, `get_daily_summary`, `get_goals`, `get_nutrition_history` | `add_food_entry`, `add_quick_entry`, `add_recipe_entry`, `remove_diary_entry` |
| Water | `get_water_intake` | `add_water` |
| Activity | `get_exercises` | `add_exercise`, `remove_exercise` |
| Body | `get_body_values`, `get_body_value_history`, `get_streak` | `add_body_value`, `remove_body_value` |
| Catalogue | `search_products`, `get_product`, `get_suggested_products`, `search_recipes`, `get_recipe`, `get_my_recipes` | |

<details>
<summary><strong>What the less obvious tools do</strong></summary>
<br>

- **`get_diary`**: all entries of a day grouped by meal, with product names and nutrients per entry, per meal and for the day (kcal, protein, carbs, fat, sugar, fibre, saturated fat, salt).
- **`get_nutrition_history`**: kcal, macros and the calorie goal per day for any range in one request. Extra nutrients such as `nutrient.sugar` or `mineral.iron` can be added by key.
- **`add_food_entry`**: takes an amount in g/ml, or a serving name like `piece` plus a quantity; the amount is then calculated from the product.
- **`add_quick_entry`**: logs a name with kcal and optional macros, like the app's quick add. For food that is not in the database.
- **`add_water`**: adds to the day total (`amount_ml`) or sets it (`total_ml`). YAZIO stores one cumulative value per day.
- **`add_exercise`**: known names such as `running` or `strengthtraining` become standard trainings, anything else a custom training.
- **`add_body_value`**: weight, body fat and muscle ratio, five circumferences, glucose and blood pressure.
- **`search_products`**: name, brand or EAN barcode. The food market follows the profile language (`de` → `DE`), because the profile country is often just where the account was created.
- **`get_daily_summary`** vs **`get_goals`**: the summary's calorie goal includes burned activity calories, `get_goals` returns the base goal.

</details>

## Quick start

### Let your AI agent install it

Copy this prompt into an agent with local terminal and file access:

```text
Read https://raw.githubusercontent.com/nichtlegacy/yazio-mcp/master/docs/agent-installation.md and follow it to install, globally configure, and verify yazio-mcp for my AI clients.
```

[Installation guide](docs/agent-installation.md) · Supports Claude Code, Claude Desktop, Codex, and Cursor.

### Manual installation

Build from source; the fork is not published to npm.

```bash
git clone https://github.com/nichtlegacy/yazio-mcp.git
cd yazio-mcp
npm ci
npm run build            # dist/index.js, all dependencies bundled
```

Then expand the instructions for your client. Replace `/path/to/yazio-mcp` with
the absolute path to your clone and use your YAZIO account credentials.

<details>
<summary><strong>Claude Code</strong></summary>

Register globally for your user (omit `--scope user` for a local setup):

```bash
claude mcp add --scope user yazio \
  -e YAZIO_USERNAME=you@example.com \
  -e YAZIO_PASSWORD='your-password' \
  -- node /path/to/yazio-mcp/dist/index.js
```

</details>

<details>
<summary><strong>Claude Desktop</strong></summary>

For a one-click installation, download `yazio-mcp.mcpb` from the
[latest release](https://github.com/nichtlegacy/yazio-mcp/releases/latest) and
open it in Claude Desktop. It asks for your email and password during installation.
To build the bundle yourself, run `npm run build:mcpb`.

Alternatively, add this to `claude_desktop_config.json` and restart Claude Desktop:

```json
{
  "mcpServers": {
    "yazio": {
      "command": "node",
      "args": ["/path/to/yazio-mcp/dist/index.js"],
      "env": {
        "YAZIO_USERNAME": "you@example.com",
        "YAZIO_PASSWORD": "your-password"
      }
    }
  }
}
```

</details>

<details>
<summary><strong>OpenAI Codex (CLI and IDE extension)</strong></summary>

Register the server with the Codex CLI:

```bash
codex mcp add yazio \
  --env YAZIO_USERNAME=you@example.com \
  --env YAZIO_PASSWORD='your-password' \
  -- node /path/to/yazio-mcp/dist/index.js
```

Alternatively, add this to `~/.codex/config.toml`. The CLI and Codex IDE extension
share this configuration:

```toml
[mcp_servers.yazio]
command = "node"
args = ["/path/to/yazio-mcp/dist/index.js"]

[mcp_servers.yazio.env]
YAZIO_USERNAME = "you@example.com"
YAZIO_PASSWORD = "your-password"
```

Start a new Codex session after adding the server. Use `codex mcp list` to check
that `yazio` is registered.

</details>

<details>
<summary><strong>Cursor</strong></summary>

Add this to `~/.cursor/mcp.json` for all projects, or `.cursor/mcp.json` in your
project for a project-specific setup. If the file already contains servers, add
`yazio` to the existing `mcpServers` object.

```json
{
  "mcpServers": {
    "yazio": {
      "command": "node",
      "args": ["/path/to/yazio-mcp/dist/index.js"],
      "env": {
        "YAZIO_USERNAME": "you@example.com",
        "YAZIO_PASSWORD": "your-password"
      }
    }
  }
}
```

Open Cursor Settings → Tools & MCP and check that `yazio` is enabled. Keep any
project configuration containing your credentials out of version control.

</details>

Expected: the client lists 25 `yazio` tools, and "what did I eat yesterday?" returns your diary.

Other stdio MCP clients can use the same `command`, `args` and `env` values as
the JSON examples above.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `YAZIO_USERNAME` | — | Account email (`YAZIO_EMAIL` works too) |
| `YAZIO_PASSWORD` | — | Account password |
| `YAZIO_API_VERSION` | `v18` | API version segment, see [API notes](docs/api-notes.md#versions-and-authentication) |
| `TZ` | system zone | Decides what "today" and "now" mean for new entries |

The login happens on the first tool call. Tokens are kept in memory and refreshed
automatically; nothing is written to disk.

## Development

```bash
npm test                 # unit tests + tools via an in-memory MCP client, offline
npm run lint
npm run type-check
npm run test:e2e         # live run against your account, needs the env vars above
```

`test:e2e` starts the built server over stdio, calls every read tool and runs each
write tool as create → verify → delete → verify on a day 35 days in the past. It
leaves nothing behind unless the API itself fails mid-run.

```text
src/
├── index.ts       # entry: env, server, stdio transport
├── tools.ts       # the 25 MCP tools
├── yazio.ts       # API client: auth, refresh, errors
├── diary.ts       # diary enrichment and nutrient maths
└── dates.ts       # local dates and API timestamps
test/              # node:test suites and the live e2e script
docs/api-notes.md  # verified API contract
```

## Known limitations

- It is a private API. YAZIO already blocks API versions it no longer wants; the server reports that as a clear error, and `YAZIO_API_VERSION` can move to another version.
- Fasting, feelings, goal changes and custom product creation are not available (see [API notes](docs/api-notes.md#not-available)).
- Entries cannot be edited in place; remove and add again.
- Account suspension for API use is a documented risk in other projects. A tool call makes a few requests at most, and catalogue lookups are cached for the session.

## Credits

Forked from **[fliptheweb/yazio-mcp](https://github.com/fliptheweb/yazio-mcp)** by
fliptheweb, which built the first YAZIO MCP server on top of
**[juriadams/yazio](https://github.com/juriadams/yazio)**. This fork replaced both with
its own client and toolset. The API research builds on
**[saganos/yazio_public_api](https://github.com/saganos/yazio_public_api)**,
**[controlado/go-yazio](https://github.com/controlado/go-yazio)** and
**[aleksandr-bogdanov/yazio-exporter](https://github.com/aleksandr-bogdanov/yazio-exporter)**.

## License

[MIT](LICENSE), inherited from the upstream project and unchanged.

## Disclaimer

**yazio-mcp is an unofficial, independent hobby project.** It is not affiliated with,
endorsed by, sponsored by, or connected to YAZIO GmbH in any way.

"YAZIO" and related marks are trademarks of their respective owners and are used here
only to describe the service this server talks to. Use it with your own account and at
your own risk.
