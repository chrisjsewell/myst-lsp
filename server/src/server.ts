#!/usr/bin/env node
/* --------------------------------------------------------------------------------------------
 * Licensed under the MIT License. See License file in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  DidChangeConfigurationNotification,
  CompletionItem,
  CompletionItemKind,
  TextDocumentPositionParams,
  TextDocumentSyncKind,
  InitializeResult,
  _Connection,
  DidChangeConfigurationParams,
  DidChangeWatchedFilesParams,
  TextDocumentChangeEvent,
  FoldingRange,
  FoldingRangeParams,
  Hover,
  InitializedParams,
  DocumentHighlight,
  SemanticTokensParams,
  SemanticTokens
} from "vscode-languageserver/node"
import { TextDocument } from "vscode-languageserver-textdocument"

import MarkdownIt = require("markdown-it")
import Token = require("markdown-it/lib/token")
import frontMatterPlugin = require("markdown-it-front-matter")

import * as dirDict from "./directives.json"
import {
  matchDirectiveName,
  makeDescription,
  matchDirectiveStart
} from "./directiveUtils"
import { mystBlocksPlugin } from "./mdPluginMyst"
import { divPlugin } from "./mdPluginDiv"

interface ServerSettings {
  /** The tokens to apply folding to */
  foldingTokens: string[]
  /** Markdown-it extensions */
  MdExtensions: string[]
}

export interface IDocData {
  doc: TextDocument
  tokens: Token[]
  definitions: { [key: string]: { title: string; href: string } }
  targets: string[]
  lineToTokenIndex: number[][]
}

class Server {
  connection: _Connection
  hasConfigurationCapability: boolean
  hasWorkspaceFolderCapability: boolean
  hasDiagnosticRelatedInformationCapability: boolean
  defaultSettings: ServerSettings
  globalSettings: ServerSettings
  documentSettings: Map<string, Thenable<ServerSettings>>
  documentData: Map<string, IDocData>
  documents: TextDocuments<TextDocument>

  constructor() {
    this.hasConfigurationCapability = false
    this.hasWorkspaceFolderCapability = false
    this.hasDiagnosticRelatedInformationCapability = false

    this.defaultSettings = {
      MdExtensions: ["colon_fence"],
      foldingTokens: [
        "paragraph_open",
        "blockquote_open",
        "bullet_list_open",
        "ordered_list_open",
        "code_block",
        "fence",
        "html_block",
        "table_open",
        "div_open"
      ]
    }
    // The global settings, used when the `workspace/configuration` request is not supported by the client.
    this.globalSettings = this.defaultSettings
    // Cache the settings of all open documents
    this.documentSettings = new Map()

    this.documentData = new Map()

    // Create a connection for the server, using Node's IPC as a transport.
    // Also include all preview / proposed LSP features.
    this.connection = createConnection(ProposedFeatures.all)

    // Create a simple text document manager.
    this.documents = new TextDocuments(TextDocument)

    this.connection.onInitialize(this.onInitialize.bind(this))
    this.connection.onInitialized(this.onInitialized.bind(this))
    this.connection.onDidChangeConfiguration(this.onDidChangeConfiguration.bind(this))
    // Only keep settings for open documents
    this.documents.onDidClose(e => {
      this.documentSettings.delete(e.document.uri)
      this.documentData.delete(e.document.uri)
    })

    // Features
    this.documents.onDidChangeContent(this.onDidChangeContent.bind(this))
    this.connection.onDidChangeWatchedFiles(this.onDidChangeWatchedFiles.bind(this))
    this.connection.onCompletion(this.onCompletion.bind(this))
    this.connection.onCompletionResolve(this.onCompletionResolve.bind(this))
    this.connection.onHover(this.onHover.bind(this))
    this.connection.onFoldingRanges(this.onFoldingRanges.bind(this))

    // Make the text document manager listen on the connection
    // for open, change and close text document events
    this.documents.listen(this.connection)

    // Listen on the connection
    this.connection.listen()
  }

  onInitialize(params: InitializeParams) {
    const capabilities = params.capabilities

    // Does the client support the `workspace/configuration` request?
    // If not, we fall back using global settings.
    this.hasConfigurationCapability = !!(
      capabilities.workspace && !!capabilities.workspace.configuration
    )
    this.hasWorkspaceFolderCapability = !!(
      capabilities.workspace && !!capabilities.workspace.workspaceFolders
    )
    this.hasDiagnosticRelatedInformationCapability = !!(
      capabilities.textDocument &&
      capabilities.textDocument.publishDiagnostics &&
      capabilities.textDocument.publishDiagnostics.relatedInformation
    )

    const result: InitializeResult = {
      capabilities: {
        textDocumentSync: TextDocumentSyncKind.Incremental,
        // Tell the client that this server supports code completion.
        completionProvider: {
          resolveProvider: true,
          triggerCharacters: ["{", "[", "("]
        },
        foldingRangeProvider: true,
        hoverProvider: true
      }
    }
    if (this.hasWorkspaceFolderCapability) {
      result.capabilities.workspace = {
        workspaceFolders: {
          supported: true
        }
      }
    }

    return result
  }

  onInitialized(params: InitializedParams) {
    if (this.hasConfigurationCapability) {
      // Register for all configuration changes.
      this.connection.client.register(
        DidChangeConfigurationNotification.type,
        undefined
      )
    }
    if (this.hasWorkspaceFolderCapability) {
      this.connection.workspace.onDidChangeWorkspaceFolders(_event => {
        this.connection.console.log("Workspace folder change event received.")
      })
    }
  }

  getDocumentSettings(resource: string): Thenable<ServerSettings> {
    if (!this.hasConfigurationCapability) {
      return Promise.resolve(this.globalSettings)
    }
    let result = this.documentSettings.get(resource)
    if (!result) {
      result = this.connection.workspace.getConfiguration({
        scopeUri: resource,
        section: "languageServerMyst"
      })
      this.documentSettings.set(resource, result)
    }
    return result
  }

  onDidChangeConfiguration(change: DidChangeConfigurationParams) {
    if (this.hasConfigurationCapability) {
      // Reset all cached document settings
      this.documentSettings.clear()
    } else {
      this.globalSettings = change.settings.languageServerMyst || this.defaultSettings
    }

    // Re-parse all open text documents
    this.documents.all().forEach(this.parseTextDocument.bind(this))
  }

  async parseTextDocument(textDocument: TextDocument): Promise<void> {
    // For now we simply get the settings for every parse.
    const settings = await this.getDocumentSettings(textDocument.uri)

    // The validator creates diagnostics for all uppercase words length 2 and more
    const text = textDocument.getText()

    const md = new MarkdownIt("commonmark", {})
    md.use(mystBlocksPlugin)
    if (settings.MdExtensions.includes("colon_fence")) {
      md.use(divPlugin)
    }
    md.use(frontMatterPlugin, () => {})
    md.enable("table")
    md.disable(["inline", "text_join"])
    // TODO make a plugin that outputs link definitions as tokens (to get map)
    const env: { references: { [key: string]: { title: string; href: string } } } = {
      references: {}
    }
    const tokens = md.parse(text, env)

    // create a mapping of line number to token indexes that span that line
    // this is used for cursor based server queries, such as hover and completions
    const lineToTokenIndex: number[][] = []
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]
      if (!token.map) {
        continue
      }
      // loop through all lines the token spans
      for (let j = token.map[0]; j < token.map[1]; j++) {
        if (lineToTokenIndex[j] === undefined) {
          lineToTokenIndex[j] = []
        }
        lineToTokenIndex[j].push(i)
      }
    }

    this.documentData.set(textDocument.uri, {
      doc: textDocument,
      tokens: tokens,
      definitions: env.references,
      targets: tokens.filter(t => t.type === "myst_target").map(t => t.content),
      lineToTokenIndex: lineToTokenIndex
    })
  }

  async onFoldingRanges(params: FoldingRangeParams): Promise<FoldingRange[]> {
    const textDocument = this.documents.get(params.textDocument.uri)
    if (!textDocument) {
      return []
    }
    const settings = await this.getDocumentSettings(textDocument.uri)
    const foldingRanges: FoldingRange[] = []
    for (const token of this.documentData.get(textDocument.uri)?.tokens || []) {
      if (token.map && settings.foldingTokens.includes(token.type)) {
        foldingRanges.push({
          startLine: token.map[0],
          endLine: token.map[1] - 1
        })
      }
    }
    return foldingRanges
  }

  // The content of a text document has changed. This event is emitted
  // when the text document first opened or when its content has changed.
  onDidChangeContent(change: TextDocumentChangeEvent<TextDocument>) {
    // console.log(`Received onDidChangeContent event: ${change.document.uri}`)
    this.parseTextDocument(change.document)
  }

  // Monitored files have changed
  onDidChangeWatchedFiles(change: DidChangeWatchedFilesParams) {
    // console.log(`Received onDidChangeWatchedFiles event: ${change.changes}`)
  }

  // This handler provides the initial list of the completion items.
  onCompletion(textDocumentPosition: TextDocumentPositionParams): CompletionItem[] {
    // The pass parameter contains the position of the text document in
    // which code complete got requested. For the example we ignore this
    // info and always provide the same completion items.

    const docData = this.documentData.get(textDocumentPosition.textDocument.uri)
    if (!docData) {
      return []
    }

    const indexes = docData.lineToTokenIndex[textDocumentPosition.position.line] || []

    const completionItems: CompletionItem[] = []
    for (const index of indexes) {
      const token = docData.tokens[index]
      if (
        token.map &&
        textDocumentPosition.position.line === token.map[0] &&
        (token.type === "fence" || token.type === "div_open")
      ) {
        if (matchDirectiveStart(docData, textDocumentPosition)) {
          const dict: { [key: string]: { name: string } } = dirDict
          for (const name in dirDict) {
            const data = dict[name]
            completionItems.push({
              label: data.name,
              kind: CompletionItemKind.Class,
              data: "myst.directive"
            })
          }
        }
      }
      if (token.type === "inline") {
        const charPreceding = docData.doc.getText({
          start: {
            line: textDocumentPosition.position.line,
            character: textDocumentPosition.position.character - 2
          },
          end: {
            line: textDocumentPosition.position.line,
            character: textDocumentPosition.position.character
          }
        })
        if (charPreceding === "](") {
          for (const name of docData.targets) {
            completionItems.push({
              label: name,
              kind: CompletionItemKind.Reference,
              data: "myst.targets"
            })
          }
        }
        if (charPreceding === "][") {
          for (const name in docData.definitions) {
            const data = docData.definitions[name]
            completionItems.push({
              label: name,
              kind: CompletionItemKind.Reference,
              documentation: data.href,
              data: "myst.definition"
            })
          }
        }
      }
    }

    return completionItems
  }

  onHover(params: TextDocumentPositionParams): Hover | null {
    const docData = this.documentData.get(params.textDocument.uri)
    if (!docData) {
      return null
    }

    const indexes = docData.lineToTokenIndex[params.position.line] || []

    for (const index of indexes) {
      const token = docData.tokens[index]
      if (
        token.map &&
        params.position.line === token.map[0] &&
        (token.type === "fence" || token.type === "div_open")
      ) {
        const name = matchDirectiveName(docData, params)
        if (name) {
          const dict: { [key: string]: { name: string } } = dirDict
          const data = dict[name]
          if (data) {
            return {
              contents: makeDescription(data)
            }
          }
        }
      }
    }

    return null
  }

  // This handler resolves additional information for the item selected in
  // the completion list.
  onCompletionResolve(item: CompletionItem): CompletionItem {
    if (item.data === "myst.directive") {
      const dict: { [key: string]: { name: string } } = dirDict
      const data = dict[item.label]
      item.documentation = makeDescription(data)
    }
    return item
  }
}

new Server()
