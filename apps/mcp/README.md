# SumMeet MCP server (roadmap A12)

Exposes your meeting history as **read-only** tools an AI assistant can query — so you
can ask, in Claude Desktop (or any MCP client):

> "What did I commit to this week?"
> "Every decision we made about pricing."
> "Summarise the meetings that mention the Citrus project."

It talks to the **local** SumMeet API over HTTP — the same data path the app uses — so
nothing leaves your machine unless *you* point a cloud assistant at it, and it can never
write or delete.

## Tools

| Tool | What |
|---|---|
| `search_meetings` | Find meetings by title substring / status. |
| `get_meeting` | The full decision record for one meeting (insights + transcript). |
| `list_commitments` | Action items across all meetings; `owner="You"` for your own. Optional date range. |
| `list_decisions` | Decisions across all meetings, with rationale and source quote. Optional date range. |

## Requirements

The SumMeet API must be running — open **SumMeet.app**, or `pnpm dev`. The MCP server is a
thin client over it (`SUMMEET_API_BASE`, default `http://localhost:8080`).

## Wire it into Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "summeet": {
      "command": "pnpm",
      "args": ["--filter", "@summeet/mcp", "exec", "tsx", "src/server.ts"],
      "cwd": "/absolute/path/to/SumMeet"
    }
  }
}
```

Restart Claude Desktop; the SumMeet tools appear in the tools menu. Point
`SUMMEET_API_BASE` at a different host/port via the config's `env` if you moved the API.
