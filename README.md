# myst-lsp

A Language Server Protocol provider for MyST Markdown.

## Development

### Repository structure

This was originally adapted from <https://github.com/microsoft/vscode-extension-samples/tree/main/lsp-sample>

```
.
├── package.json // The extension manifest.
└── server // Language Server
|   └── src
|       ├── server.ts // Language Server entry point
|       └── ...
└── vscode-client // VS Code Language Client
    └── src
        ├── extension.ts // Language Client entry point
        └── test // End to End tests for Language Client / Server
```

### Launching in VS Code

- Run `npm install` in this folder. This installs all necessary npm modules in both the client and server folder
- Open VS Code on this folder.
- Press Ctrl+Shift+B to start compiling the client and server in [watch mode](https://code.visualstudio.com/docs/editor/tasks#:~:text=The%20first%20entry%20executes,the%20HelloWorld.js%20file.).
- Switch to the Run and Debug View in the Sidebar (Ctrl+Shift+D).
- Select `Launch Client` from the drop down (if it is not already).
- Press ▷ to run the launch config (F5).
- If you want to debug the server as well, use the launch configuration `Attach to Server`
- In the [Extension Development Host](https://code.visualstudio.com/api/get-started/your-first-extension#:~:text=Then%2C%20inside%20the%20editor%2C%20press%20F5.%20This%20will%20compile%20and%20run%20the%20extension%20in%20a%20new%20Extension%20Development%20Host%20window.) instance of VSCode, open a Markdown document.

## Launching in Jupyter Lab

See <https://github.com/jupyter-lsp/jupyterlab-lsp>

1. Run `npm run compile`
2. Make script executable: `chmod +x server/out/server.js`
3. Add server configuration: `~/.jupyter/jupyter_server_config.json`:

```json
{
  "LanguageServerManager": {
    "language_servers": {
      "myst-language-server-implementation": {
        "version": 2,
        "argv": ["/path/to/myst-lsp/server/out/server.js", "--stdio"],
        "languages": ["Markdown"],
        "mime_types": ["text/markdown"],
        "display_name": "MyST LSP server"
      }
    }
  }
}
```

4. Install jupyterlab-lsp and start jupyter lab:

   ```console
   $ mamba create -n myst-lsp "jupyterlab-lsp>=3.3.0,<4.0.0a0"
   $ conda activate myst-lsp
   $ jupyter lab
   ```

5. Open a Markdown file, and make sure the file type is set to `MyST`

## TODO / Notes

- [ ] folding rang for headings
- [ ] diagnostics if heading levels are not sequential
- [ ] background reading of all files in the workspace (to populate targets lookup)
- [ ] markdown-it-front-matter plugin sets wrong map (uses `pos` instead of `nextLine`)

### Jupyterlab-lsp

- How do stop `.md` files from being opened as `ipythongfm`?
- How do you trigger completions with with key-bindings (e.g. with VS Code is `ctrl+space`)?
  - edit: I managed to get it to activate a few times with after writing `:::{not`, but seems very temperamental?
  - actually it seems to work fine with `[` and `(`, but not with `{`
- Enabling for notebooks (coming in v4.0?)

### VS Code

- Enabling for notebooks
