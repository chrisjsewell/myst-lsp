# myst-lsp

**IN DEVELOPMENT**

[![npm-badge]][npm-link]
[![VS Marketplace][vs-market-badge]][vs-market-link]
[![Binder][binder-badge]][binder-link]

A Language Server Protocol provider for MyST Markdown.
It works in both Markdown text files and Notebook Markdown cells (if supported by the client).

- Hover on directive names
- Autocompletion on directive names
- Autocompletion on role names
- Background analysis of Markdown files and Jupyter notebooks in the project
  - Configuration with `myst.yml` file
- Autocompletion in Markdown links and "Jump to definition"
  - Cross document targets and named directives
- Folding ranges for content blocks
- Semantic highlighting of MyST Markdown syntax

![vscode demonstration](static/demo-vscode.gif)

![jupyterlab demonstration](static/demo-jupyterlab.gif)

## Usage

In VS Code, simply install the [MyST LSP extension][vs-market-link].

In JupyterLab, currently you need to setup the server manually.
Add a server configuration to e.g. `~/.jupyter/jupyter_server_config.json`:

```json
{
  "LanguageServerManager": {
    "language_servers": {
      "myst-lsp": {
        "version": 2,
        "argv": ["npx", "--yes", "myst-lsp", "--stdio"],
        "languages": ["ipythongfm"],
        "mime_types": ["text/x-markdown"],
        "display_name": "MyST LSP server"
      }
    }
  }
}
```

Then install [jupyterlab-lsp] and [nodejs](https://nodejs.org) (plus npm), and start JupyterLab.
Its recommended to use a [Conda](https://docs.conda.io/en/latest/miniconda.html) environment for this (plus [mamba](https://github.com/mamba-org/mamba)), e.g.:

```console
$ mamba env create -f binder/environment.yml
$ conda activate myst-lsp-jlab-dev
$ jupyter lab
```

### Client capabilities

| Feature            | VS Code | JupyterLab |
| ------------------ | :-----: | :--------: |
| Notebook Cells     |   ✅    |     ❌     |
| Hover              |   ✅    |     ✅     |
| Completion         |   ✅    |     ✅     |
| Definitions        |   ✅    |     ✅     |
| Folding ranges     |   ✅    |     ❌     |
| Semantic highlight |   ✅    |     ❌     |

Note that by default, VS-Code uses `CTRL+SPACE` to trigger completions,
whereas JupyterLab uses `Tab` to trigger completions.

## Development

### Repository structure

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

See [jupyterlab-lsp]:

1. Run `npm run compile`
2. Add server configuration: `~/.jupyter/jupyter_server_config.json`:

```json
{
  "LanguageServerManager": {
    "language_servers": {
      "myst-lsp": {
        "version": 2,
        "argv": ["/path/to/myst-lsp/server/out/server.js", "--stdio"],
        "languages": ["ipythongfm"],
        "mime_types": ["text/x-markdown"],
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

5. Open a Markdown file, and make sure the file type is set to `ipythongfm`

## TODO / Notes

From https://github.com/microsoft/language-server-protocol/issues/1465#issuecomment-1119545029:

> In general the design of LSP is that the server runs where the files are.
> So it is currently common pratice that a server accesses the file system directly (minus the files for which the server received an open event since this transfers the file's ownership to the client)

- [ ] Parse `myst.yml` before first project analysis
- [ ] utf-16 encoding? https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#textDocuments
- [ ] folding range for headings
- [ ] diagnostics, e.g. if heading levels are not sequential, unused definitions, unknown definitions/links/directives/roles
- [ ] background reading of all files in the workspace (to populate targets lookup etc)
  - [x] text files
  - [x] notebooks
    - how to get the correct uri for a cell? https://github.com/microsoft/language-server-protocol/issues/1399 (see also https://github.com/microsoft/vscode/issues/123025 would be ideal to get data from the client)
- [x] parsing of directive options, which could then be used to add to targets lookup (i.e. for any `name` option)
- [ ] markdown-it-front-matter plugin sets wrong map (uses `pos` instead of `nextLine`) which causes wrong folding range etc
- [ ] workspace support (e.g. for targets lookup)
- [ ] use the client's file watcher for `myst.yml`, if the client supports it
- [ ] watch all files in project (and reparse), or just assume that the only files changing are those sent by the client?
  - pyright uses the client file watching if available (https://github.com/microsoft/pyright/blob/50e12b4bea4fcdb61d96f855ca1e430bb8b41ca8/packages/pyright-internal/src/languageServerBase.ts#L666), then `chokidar` when file watching is not implemented (https://github.com/microsoft/pyright/blob/50e12b4bea4fcdb61d96f855ca1e430bb8b41ca8/packages/pyright-internal/src/common/chokidarFileWatcherProvider.ts#L9)
- [ ] intersphinx support
- [ ] doi hover (and other links/autolinks?)

### Jupyterlab-lsp

- [ ] How do stop `.md` files from being opened as `ipythongfm`?
  - <https://github.com/jupyterlab/jupyterlab/issues/4223>
- [ ] Enabling for notebooks (coming in v4.0?)

### VS Code

- [x] Enabling for notebooks

### Current Feature Support

As of jupyterlab-lsp v3.10.2, `InitializeParams` returns:

```json
{
  "capabilities": {
    "textDocument": {
      "synchronization": {
        "dynamicRegistration": true,
        "willSave": false,
        "didSave": true,
        "willSaveWaitUntil": false
      },
      "completion": {
        "dynamicRegistration": true,
        "completionItem": {
          "snippetSupport": false,
          "commitCharactersSupport": true,
          "documentationFormat": ["markdown", "plaintext"],
          "deprecatedSupport": true,
          "preselectSupport": false,
          "tagSupport": { "valueSet": [1] }
        },
        "contextSupport": false
      },
      "signatureHelp": {
        "dynamicRegistration": true,
        "signatureInformation": {
          "documentationFormat": ["markdown", "plaintext"]
        }
      },
      "hover": {
        "dynamicRegistration": true,
        "contentFormat": ["markdown", "plaintext"]
      },
      "publishDiagnostics": { "tagSupport": { "valueSet": [2, 1] } },
      "declaration": { "dynamicRegistration": true, "linkSupport": true },
      "definition": { "dynamicRegistration": true, "linkSupport": true },
      "typeDefinition": { "dynamicRegistration": true, "linkSupport": true },
      "implementation": { "dynamicRegistration": true, "linkSupport": true }
    },
    "workspace": { "didChangeConfiguration": { "dynamicRegistration": true } }
  },
  "processId": null,
  "rootUri": "file:///Users/chrisjsewell/Documents/GitHub/myst-lsp",
  "workspaceFolders": null,
  "initializationOptions": null
}
```

As of vscode 1.72, `InitializeParams` returns:

```json
{
  "processId": 10069,
  "clientInfo": { "name": "Visual Studio Code", "version": "1.72.0" },
  "locale": "en-gb",
  "rootPath": "/Users/chrisjsewell/Documents/GitHub/vscode_extension_test_folder",
  "rootUri": "file:///Users/chrisjsewell/Documents/GitHub/vscode_extension_test_folder",
  "capabilities": {
    "workspace": {
      "applyEdit": true,
      "workspaceEdit": {
        "documentChanges": true,
        "resourceOperations": ["create", "rename", "delete"],
        "failureHandling": "textOnlyTransactional",
        "normalizesLineEndings": true,
        "changeAnnotationSupport": { "groupsOnLabel": true }
      },
      "configuration": true,
      "didChangeWatchedFiles": {
        "dynamicRegistration": true,
        "relativePatternSupport": true
      },
      "symbol": {
        "dynamicRegistration": true,
        "symbolKind": {
          "valueSet": [
            1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
            22, 23, 24, 25, 26
          ]
        },
        "tagSupport": { "valueSet": [1] },
        "resolveSupport": { "properties": ["location.range"] }
      },
      "codeLens": { "refreshSupport": true },
      "executeCommand": { "dynamicRegistration": true },
      "didChangeConfiguration": { "dynamicRegistration": true },
      "workspaceFolders": true,
      "semanticTokens": { "refreshSupport": true },
      "fileOperations": {
        "dynamicRegistration": true,
        "didCreate": true,
        "didRename": true,
        "didDelete": true,
        "willCreate": true,
        "willRename": true,
        "willDelete": true
      },
      "inlineValue": { "refreshSupport": true },
      "inlayHint": { "refreshSupport": true },
      "diagnostics": { "refreshSupport": true }
    },
    "textDocument": {
      "publishDiagnostics": {
        "relatedInformation": true,
        "versionSupport": false,
        "tagSupport": { "valueSet": [1, 2] },
        "codeDescriptionSupport": true,
        "dataSupport": true
      },
      "synchronization": {
        "dynamicRegistration": true,
        "willSave": true,
        "willSaveWaitUntil": true,
        "didSave": true
      },
      "completion": {
        "dynamicRegistration": true,
        "contextSupport": true,
        "completionItem": {
          "snippetSupport": true,
          "commitCharactersSupport": true,
          "documentationFormat": ["markdown", "plaintext"],
          "deprecatedSupport": true,
          "preselectSupport": true,
          "tagSupport": { "valueSet": [1] },
          "insertReplaceSupport": true,
          "resolveSupport": {
            "properties": ["documentation", "detail", "additionalTextEdits"]
          },
          "insertTextModeSupport": { "valueSet": [1, 2] },
          "labelDetailsSupport": true
        },
        "insertTextMode": 2,
        "completionItemKind": {
          "valueSet": [
            1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
            22, 23, 24, 25
          ]
        },
        "completionList": {
          "itemDefaults": [
            "commitCharacters",
            "editRange",
            "insertTextFormat",
            "insertTextMode"
          ]
        }
      },
      "hover": {
        "dynamicRegistration": true,
        "contentFormat": ["markdown", "plaintext"]
      },
      "signatureHelp": {
        "dynamicRegistration": true,
        "signatureInformation": {
          "documentationFormat": ["markdown", "plaintext"],
          "parameterInformation": { "labelOffsetSupport": true },
          "activeParameterSupport": true
        },
        "contextSupport": true
      },
      "definition": { "dynamicRegistration": true, "linkSupport": true },
      "references": { "dynamicRegistration": true },
      "documentHighlight": { "dynamicRegistration": true },
      "documentSymbol": {
        "dynamicRegistration": true,
        "symbolKind": {
          "valueSet": [
            1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
            22, 23, 24, 25, 26
          ]
        },
        "hierarchicalDocumentSymbolSupport": true,
        "tagSupport": { "valueSet": [1] },
        "labelSupport": true
      },
      "codeAction": {
        "dynamicRegistration": true,
        "isPreferredSupport": true,
        "disabledSupport": true,
        "dataSupport": true,
        "resolveSupport": { "properties": ["edit"] },
        "codeActionLiteralSupport": {
          "codeActionKind": {
            "valueSet": [
              "",
              "quickfix",
              "refactor",
              "refactor.extract",
              "refactor.inline",
              "refactor.rewrite",
              "source",
              "source.organizeImports"
            ]
          }
        },
        "honorsChangeAnnotations": false
      },
      "codeLens": { "dynamicRegistration": true },
      "formatting": { "dynamicRegistration": true },
      "rangeFormatting": { "dynamicRegistration": true },
      "onTypeFormatting": { "dynamicRegistration": true },
      "rename": {
        "dynamicRegistration": true,
        "prepareSupport": true,
        "prepareSupportDefaultBehavior": 1,
        "honorsChangeAnnotations": true
      },
      "documentLink": { "dynamicRegistration": true, "tooltipSupport": true },
      "typeDefinition": { "dynamicRegistration": true, "linkSupport": true },
      "implementation": { "dynamicRegistration": true, "linkSupport": true },
      "colorProvider": { "dynamicRegistration": true },
      "foldingRange": {
        "dynamicRegistration": true,
        "rangeLimit": 5000,
        "lineFoldingOnly": true,
        "foldingRangeKind": { "valueSet": ["comment", "imports", "region"] },
        "foldingRange": { "collapsedText": false }
      },
      "declaration": { "dynamicRegistration": true, "linkSupport": true },
      "selectionRange": { "dynamicRegistration": true },
      "callHierarchy": { "dynamicRegistration": true },
      "semanticTokens": {
        "dynamicRegistration": true,
        "tokenTypes": [
          "namespace",
          "type",
          "class",
          "enum",
          "interface",
          "struct",
          "typeParameter",
          "parameter",
          "variable",
          "property",
          "enumMember",
          "event",
          "function",
          "method",
          "macro",
          "keyword",
          "modifier",
          "comment",
          "string",
          "number",
          "regexp",
          "operator",
          "decorator"
        ],
        "tokenModifiers": [
          "declaration",
          "definition",
          "readonly",
          "static",
          "deprecated",
          "abstract",
          "async",
          "modification",
          "documentation",
          "defaultLibrary"
        ],
        "formats": ["relative"],
        "requests": { "range": true, "full": { "delta": true } },
        "multilineTokenSupport": false,
        "overlappingTokenSupport": false,
        "serverCancelSupport": true,
        "augmentsSyntaxTokens": true
      },
      "linkedEditingRange": { "dynamicRegistration": true },
      "typeHierarchy": { "dynamicRegistration": true },
      "inlineValue": { "dynamicRegistration": true },
      "inlayHint": {
        "dynamicRegistration": true,
        "resolveSupport": {
          "properties": [
            "tooltip",
            "textEdits",
            "label.tooltip",
            "label.location",
            "label.command"
          ]
        }
      },
      "diagnostic": {
        "dynamicRegistration": true,
        "relatedDocumentSupport": false
      }
    },
    "window": {
      "showMessage": {
        "messageActionItem": { "additionalPropertiesSupport": true }
      },
      "showDocument": { "support": true },
      "workDoneProgress": true
    },
    "general": {
      "staleRequestSupport": {
        "cancel": true,
        "retryOnContentModified": [
          "textDocument/semanticTokens/full",
          "textDocument/semanticTokens/range",
          "textDocument/semanticTokens/full/delta"
        ]
      },
      "regularExpressions": { "engine": "ECMAScript", "version": "ES2020" },
      "markdown": { "parser": "marked", "version": "1.1.0" },
      "positionEncodings": ["utf-16"]
    },
    "notebookDocument": {
      "synchronization": {
        "dynamicRegistration": true,
        "executionSummarySupport": true
      }
    }
  },
  "trace": "off",
  "workspaceFolders": [
    {
      "uri": "file:///Users/chrisjsewell/Documents/GitHub/vscode_extension_test_folder",
      "name": "vscode_extension_test_folder"
    }
  ]
}
```

## Acknowledgements

This was originally adapted from <https://github.com/microsoft/vscode-extension-samples/tree/main/lsp-sample>

[vs-market-badge]: https://vsmarketplacebadge.apphb.com/version/chrisjsewell.myst-lsp.svg "Current Release"
[vs-market-link]: https://marketplace.visualstudio.com/items?itemName=chrisjsewell.myst-lsp
[npm-badge]: https://img.shields.io/npm/v/myst-lsp.svg
[npm-link]: https://www.npmjs.com/package/myst-lsp
[jupyterlab-lsp]: https://github.com/jupyter-lsp/jupyterlab-lsp
[binder-badge]: https://mybinder.org/badge_logo.svg
[binder-link]: https://mybinder.org/v2/gh/chrisjsewell/myst-lsp/main
