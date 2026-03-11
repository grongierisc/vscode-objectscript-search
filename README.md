# ObjectScript Search

A VS Code extension that adds a **Search** panel to the InterSystems activity bar, enabling server-side search across classes, routines, and include files on an IRIS instance — directly from the same sidebar as the **Explorer** and **Servers** views.

---

## Features

| Feature | Details |
|---|---|
| **By Name** | Filter documents by name using wildcard patterns (e.g. `*Utils*`) |
| **By Content** | Search inside class method implementations and routine names |
| **Type filters** | Toggle Classes, Routines, Includes, and Web (CSP) independently |
| **Click to open** | Click any result to open it via `isfs://` in the ObjectScript editor |
| **Native UI** | Follows VS Code's color theme automatically |

## Requirements

| Extension | Purpose |
|---|---|
| [`intersystems-community.servermanager`](https://marketplace.visualstudio.com/items?itemName=intersystems-community.servermanager) | Required — manages IRIS server connections |
| [`intersystems-community.vscode-objectscript`](https://marketplace.visualstudio.com/items?itemName=intersystems-community.vscode-objectscript) | Recommended — needed to open search results |

## Setup

### 1 · Configure your server

Define your IRIS server in **User Settings** (or `intersystems.servers` in `.vscode/settings.json`):

```jsonc
// .vscode/settings.json
{
  "intersystems.servers": {
    "my-iris": {
      "webServer": {
        "host": "localhost",
        "port": 52773,
        "scheme": "http"
      },
      "username": "SuperUser"
    }
  }
}
```

### 2 · Activate the connection for your workspace

```jsonc
// .vscode/settings.json
{
  "objectscript.conn": {
    "active": true,
    "server": "my-iris",
    "ns": "USER"
  }
}
```

> **Tip:** You can also use the inline `host`/`port`/`username`/`password` fields in `objectscript.conn` without defining a named server.

### 3 · Open the Search panel

Click the InterSystems icon in the Activity Bar and expand the **Search** section.

## Extension Settings

| Setting | Default | Description |
|---|---|---|
| `objectscriptSearch.maxResults` | `100` | Maximum results returned per search |
| `objectscriptSearch.includeSystem` | `false` | Include `%`-prefixed system documents |
| `objectscriptSearch.allowSelfSignedCertificates` | `false` | Accept self-signed TLS certificates |

## How It Works

### By Name
Calls `GET /api/atelier/v1/{namespace}/docnames?filter=*{query}*` against the IRIS Atelier REST API and filters results by the selected document types.

### By Content
Runs parameterized SQL queries against the IRIS server:
- **Classes** — searches `%Dictionary.MethodDefinition.Implementation`
- **Routines / Includes** — searches `%Library.RoutineIndex` by name

## Opening Results

Clicking a result opens the document using the `isfs://` URI scheme provided by **vscode-objectscript**. The server-side workspace folder must be open for this to work.

## Development

```bash
git clone https://github.com/intersystems-community/vscode-objectscript-search
cd vscode-objectscript-search
npm install
npm run compile
# Press F5 in VS Code to launch the Extension Development Host
```

## License

MIT
