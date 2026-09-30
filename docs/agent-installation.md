# Agent installation guide

Install https://github.com/nichtlegacy/yazio-mcp locally and configure it globally
as the stdio MCP server "yazio" for my AI clients.

1. Identify my OS and installed clients: Claude Code, Claude Desktop, OpenAI
   Codex, and Cursor. If I have not specified which clients to configure, ask
   which of the detected clients I want (one, several, or all). Complete the
   independent installation and offline checks while waiting for my answer.

2. Read the repository's current README and package.json. Use an existing clone
   if available; otherwise clone into a stable user-owned directory outside
   temporary folders. Preserve any local changes. Check for Node.js >= 20 and
   npm; install them using the platform's normal package manager if needed.
   Run npm ci, npm run build, npm test, npm run lint, and npm run type-check.
   Resolve failures before configuring clients. This fork is not on npm;
   do not substitute another package or the upstream server.

3. Use my YAZIO email as YAZIO_USERNAME and password as YAZIO_PASSWORD. If they
   are missing, ask me to provide them through secure local input or a local
   credentials file; do not ask me to paste my password into chat. Never print
   credentials, tokens, complete configuration files, or private account data.
   Pass secrets through structured file edits or a subprocess environment,
   not literal shell commands. Explain that client env configuration stores
   credentials locally, and restrict access to files containing them.

4. Back up each existing client configuration before editing it. Merge only
   the yazio entry and preserve all other servers, settings, and file access
   permissions. Update an existing yazio entry rather than creating duplicates.
   Use absolute paths to both the Node executable and the built dist/index.js
   so GUI clients work even when their PATH differs from the terminal's.
   Set command to that Node path, args to [the absolute dist/index.js path],
   and env to YAZIO_USERNAME and YAZIO_PASSWORD. Configure the selected clients:
   - Claude Code: user scope (--scope user), not local or project scope.
     Check the installed CLI's help; its user configuration is ~/.claude.json.
   - Claude Desktop: merge mcpServers.yazio in claude_desktop_config.json.
     On macOS this is ~/Library/Application Support/Claude/; on Windows it is
     %APPDATA%\Claude\. For other platforms, locate the installed client's
     actual configuration rather than assuming a path.
   - Codex: ~/.codex/config.toml, using [mcp_servers.yazio] for command/args and
     [mcp_servers.yazio.env] for credentials. This serves CLI and IDE extension.
   - Cursor: ~/.cursor/mcp.json, using mcpServers.yazio. Do not use a project's
     .cursor/mcp.json for this global installation.
   Parse the resulting JSON/TOML and verify each selected client's yazio entry
   without exposing its credentials.

5. Verify the built server with a real MCP client over stdio: initialize the
   connection, list tools (currently 25; compare with the checked-out source),
   and call get_daily_summary, get_diary, and search_products with query "skyr".
   Check for MCP tool errors as well as transport errors. Empty diary/search
   results are valid; do not require existing food entries or body measurements.
   Report pass/fail without printing personal data, and close the connection.
   Use the repository's MCP client dependency for a temporary smoke test if
   this agent cannot load newly configured MCP servers in its current session.
   Installation checks should only read my account. npm run test:e2e also
   writes live diary, water, exercise, and body data; run it only if I explicitly
   request live write testing after that behavior has been explained.

6. Tell me the installation path, which global client configurations changed,
   and which build, offline, and live MCP checks passed. Explain any remaining
   blocker precisely. Tell me which clients need a restart or a new session.
   Once reloaded, verify that each selected client sees yazio and can call
   get_daily_summary; if you cannot observe that, mark client activation as
   pending and give me the exact check. Do not claim activation was verified
   solely because the standalone MCP smoke test passed.
