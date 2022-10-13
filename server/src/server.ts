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
  SemanticTokensParams,
  SemanticTokens,
  FileChangeType,
  NotebookDocuments,
  NotebookDocument
} from "vscode-languageserver/node"
import { TextDocument } from "vscode-languageserver-textdocument"

import loki from "lokijs"

import MarkdownIt = require("markdown-it")
import Token from "markdown-it/lib/token"
import frontMatterPlugin = require("markdown-it-front-matter")

import * as dirDict from "./directives.json"
import * as roleDict from "./roles.json"
import {
  matchDirectiveName,
  makeDescription,
  matchDirectiveStart
} from "./directiveUtils"
import { mystBlocksPlugin } from "./mdPluginMyst"
import { divPlugin } from "./mdPluginDiv"
import { NotebookDocumentChangeEvent } from "vscode-languageserver/lib/common/notebook"

interface ServerSettings {
  /** The tokens to apply folding to */
  foldingTokens: string[]
  /** Markdown-it extensions */
  MdExtensions: string[]
}

interface ITargetData {
  uri: string
  name: string
  line: number | null
}

interface IDefinition {
  key: string
  title: string
  href: string
}

interface ICacheData {
  tokens: Token[]
  lineToTokenIndex: number[][]
  defs: IDefinition[]
}

// A cache of data for open documents
class DocCache {
  private settings: Map<string, Thenable<ServerSettings>>
  private data: Map<string, ICacheData>
  private parentToChildUri: Map<string, Set<string>>

  constructor() {
    this.settings = new Map()
    this.data = new Map()
    this.parentToChildUri = new Map()
  }

  removeUri(uri: string) {
    this.settings.delete(uri)
    this.data.delete(uri)
    // remove children in parentToChildUri
    for (const [parent, children] of this.parentToChildUri) {
      if (children.has(uri)) {
        children.delete(uri)
        if (children.size === 0) {
          this.parentToChildUri.delete(parent)
        }
      }
    }
    // remove all children of parent
    this.parentToChildUri.get(uri)?.forEach(child => {
      this.data.delete(child)
      this.settings.delete(child)
    })
    this.parentToChildUri.delete(uri)
  }

  clear() {
    this.data.clear()
    this.settings.clear()
  }

  setParentToChildUri(parentUri: string, childUri: string) {
    if (!this.parentToChildUri.has(parentUri)) {
      this.parentToChildUri.set(parentUri, new Set())
    }
    this.parentToChildUri.get(parentUri)?.add(childUri)
  }

  setSettings(uri: string, settings: Thenable<ServerSettings>) {
    this.settings.set(uri, settings)
  }

  getSettings(uri: string): Thenable<ServerSettings> | undefined {
    return this.settings.get(uri)
  }

  clearSettings() {
    this.settings.clear()
  }

  setData(uri: string, data: ICacheData) {
    this.data.set(uri, data)
  }

  getData(uri: string): ICacheData | undefined {
    return this.data.get(uri)
  }

  *iterDefs(uri: string, distinct = true): IterableIterator<IDefinition> {
    const defs: IDefinition[] = []
    const data = this.data.get(uri)
    if (data) {
      defs.push(...data.defs)
    }
    // check if uri is child of parent
    // if so add all defs from parent
    for (const [parent, children] of this.parentToChildUri) {
      if (children.has(uri)) {
        for (const child of children || []) {
          if (child !== uri) {
            const data = this.data.get(child)
            if (data) {
              defs.push(...data.defs)
            }
          }
        }
      }
    }
    const yielded = new Set<string>()
    for (const def of defs) {
      if (distinct && yielded.has(def.key)) {
        continue
      } else if (distinct) {
        yielded.add(def.key)
      }
      yield def
    }
  }
}

// A database for storing document data for the whole project
class projectDatabase {
  private db: loki
  private targets: loki.Collection<ITargetData>
  constructor() {
    this.db = new loki("data.db")
    this.targets = this.db.addCollection("targets")
  }
  removeUri(uri: string) {
    this.targets.findAndRemove({ uri })
  }
  insertTargets(targets: ITargetData[]) {
    this.targets.insert(targets)
  }
  *iterTargets(distinct = true, filter = {}): IterableIterator<ITargetData> {
    const yielded = new Set<string>()
    for (const target of this.targets.find(filter)) {
      if (distinct) {
        if (yielded.has(target.name)) {
          continue
        }
        yielded.add(target.name)
      }
      yield target
    }
  }
}

class Server {
  connection: _Connection
  hasConfigurationCapability: boolean
  hasWorkspaceFolderCapability: boolean
  hasDiagnosticRelatedInformationCapability: boolean
  defaultSettings: ServerSettings
  globalSettings: ServerSettings
  cache: DocCache
  db: projectDatabase
  documents: TextDocuments<TextDocument>
  notebooks: NotebookDocuments<TextDocument>

  constructor() {
    this.hasConfigurationCapability = false
    this.hasWorkspaceFolderCapability = false
    this.hasDiagnosticRelatedInformationCapability = false

    this.cache = new DocCache()
    this.db = new projectDatabase()

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

    // Create a connection for the server, using Node's IPC as a transport.
    // Also include all preview / proposed LSP features.
    this.connection = createConnection(ProposedFeatures.all)
    // Create a simple text document manager.
    this.documents = new TextDocuments(TextDocument)
    this.notebooks = new NotebookDocuments(TextDocument)

    this.connection.onInitialize(this.onInitialize.bind(this))
    this.connection.onInitialized(this.onInitialized.bind(this))

    // configuration synchronisation
    this.connection.onDidChangeConfiguration(this.onDidChangeConfiguration.bind(this))

    // text document synchronisation
    // TODO whats the difference with this.connection.onDidCloseTextDocument, etc
    this.documents.onDidClose(e => {
      this.cache.removeUri(e.document.uri)
    })
    this.documents.onDidOpen(this.onDocOpen.bind(this))
    this.documents.onDidChangeContent(this.onDocChange.bind(this))

    // notebook synchronisation
    this.notebooks.onDidClose(e => {
      this.cache.removeUri(e.uri)
    })
    this.notebooks.onDidOpen(this.onNbOpen.bind(this))
    this.notebooks.onDidChange(this.onNbChange.bind(this))

    // Features
    this.connection.onDidChangeWatchedFiles(this.onDidChangeWatchedFiles.bind(this))
    this.connection.onCompletion(this.onCompletion.bind(this))
    this.connection.onCompletionResolve(this.onCompletionResolve.bind(this))
    this.connection.onHover(this.onHover.bind(this))
    this.connection.onFoldingRanges(this.onFoldingRanges.bind(this))
    this.connection.languages.semanticTokens.on(this.onSemanticTokens.bind(this))

    // Make the text document managers listen on the connection
    // for open, change and close text document events
    this.documents.listen(this.connection)
    this.notebooks.listen(this.connection)

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
        notebookDocumentSync: {
          notebookSelector: [
            {
              notebook: { scheme: "file", notebookType: "jupyter-notebook" },
              cells: [{ language: "markdown" }]
            }
          ]
        },
        completionProvider: {
          resolveProvider: true,
          triggerCharacters: ["{", "[", "("]
        },
        foldingRangeProvider: true,
        hoverProvider: true,
        semanticTokensProvider: {
          documentSelector: null,
          legend: {
            tokenTypes: ["class", "property"],
            tokenModifiers: ["static", "declaration"]
          },
          full: true,
          range: false
        }
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

  getDocumentSettings(uri: string): Thenable<ServerSettings> {
    if (!this.hasConfigurationCapability) {
      return Promise.resolve(this.globalSettings)
    }
    let result = this.cache.getSettings(uri)
    if (!result) {
      result = this.connection.workspace.getConfiguration({
        scopeUri: uri,
        section: "languageServerMyst"
      })
      this.cache.setSettings(uri, result)
    }
    return result
  }

  onDidChangeConfiguration(change: DidChangeConfigurationParams) {
    if (this.hasConfigurationCapability) {
      this.cache.clear()
    } else {
      this.globalSettings = change.settings.languageServerMyst || this.defaultSettings
    }

    // Re-parse all open documents
    for (const doc of this.documents.all()) {
      this.parseTextDocument(doc)
    }
    for (const doc of this.notebooks.cellTextDocuments.all()) {
      this.parseTextDocument(doc)
      const nb = this.notebooks.findNotebookDocumentForCell(doc.uri)
      if (nb) {
        this.cache.setParentToChildUri(nb.uri, doc.uri)
      }
    }
  }

  /** Parse a text document
   *
   * @param textDocument The text document to parse
   * @param parentUri The uri of the parent document, if any
   *                  (e.g. a notebook cell will have a parent notebook URI)
   */
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
    // eslint-disable-next-line @typescript-eslint/no-empty-function
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
    const references = Object.entries(env.references).map(([k, v]) => {
      return { key: k, href: v.href, title: v.title }
    })
    this.cache.setData(textDocument.uri, {
      tokens: tokens,
      lineToTokenIndex: lineToTokenIndex,
      defs: references
    })
    this.db.insertTargets(
      tokens
        .filter(t => t.type === "myst_target")
        .map(t => {
          return {
            name: t.content,
            uri: textDocument.uri,
            line: t.map ? t.map[0] : null
          }
        })
    )
  }

  onDocOpen(change: TextDocumentChangeEvent<TextDocument>) {
    // doc open also triggers onDocChange, so nothing to do here
  }

  onDocChange(change: TextDocumentChangeEvent<TextDocument>) {
    this.parseTextDocument(change.document)
  }

  onNbOpen(nb: NotebookDocument) {
    for (const cell of nb.cells) {
      const cellDoc = this.notebooks.getCellTextDocument(cell)
      if (cellDoc) {
        this.parseTextDocument(cellDoc)
        this.cache.setParentToChildUri(nb.uri, cellDoc.uri)
      }
    }
  }

  onNbChange(change: NotebookDocumentChangeEvent) {
    if (!change.cells) {
      return
    }
    for (const cell of change.cells.removed) {
      this.cache.removeUri(cell.document)
    }
    for (const cell of change.cells.added) {
      const cellDoc = this.notebooks.getCellTextDocument(cell)
      if (cellDoc) {
        this.parseTextDocument(cellDoc)
        this.cache.setParentToChildUri(change.notebookDocument.uri, cellDoc.uri)
      }
    }
    for (const cell of change.cells.changed.textContent) {
      const cellDoc = this.notebooks.getCellTextDocument(cell)
      if (cellDoc) {
        this.parseTextDocument(cellDoc)
      }
    }
  }

  // Monitored files have changed
  onDidChangeWatchedFiles(change: DidChangeWatchedFilesParams) {
    for (const file of change.changes) {
      if (file.type === FileChangeType.Deleted) {
        this.db.removeUri(file.uri)
      }
    }
  }

  getDocument(uri: string): TextDocument | undefined {
    const doc = this.documents.get(uri)
    if (doc) {
      return doc
    }
    const cell = this.notebooks.getNotebookCell(uri)
    if (cell) {
      return this.notebooks.getCellTextDocument(cell)
    }
    return undefined
  }

  async onFoldingRanges(params: FoldingRangeParams): Promise<FoldingRange[]> {
    const textDocument = this.getDocument(params.textDocument.uri)
    if (!textDocument) {
      return []
    }
    const settings = await this.cache.getSettings(textDocument.uri)
    if (!settings) {
      return []
    }
    const foldingRanges: FoldingRange[] = []
    for (const token of this.cache.getData(textDocument.uri)?.tokens || []) {
      if (token.map && settings.foldingTokens.includes(token.type)) {
        foldingRanges.push({
          startLine: token.map[0],
          endLine: token.map[1] - 1
        })
      }
    }
    return foldingRanges
  }

  // This handler provides the initial list of the completion items.
  onCompletion(textDocumentPosition: TextDocumentPositionParams): CompletionItem[] {
    // The pass parameter contains the position of the text document in
    // which code complete got requested. For the example we ignore this
    // info and always provide the same completion items.
    let doc = this.getDocument(textDocumentPosition.textDocument.uri)
    const docData = this.cache.getData(textDocumentPosition.textDocument.uri)
    if (!docData || !doc) {
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
        if (matchDirectiveStart(doc, textDocumentPosition)) {
          for (const name in dirDict) {
            completionItems.push({
              label: name,
              kind: CompletionItemKind.Class,
              data: "myst.directive"
            })
          }
        }
      } else if (token.type === "inline" && doc) {
        const charsPreceding = doc.getText({
          start: {
            line: textDocumentPosition.position.line,
            character: textDocumentPosition.position.character - 2
          },
          end: {
            line: textDocumentPosition.position.line,
            character: textDocumentPosition.position.character
          }
        })
        if (charsPreceding === "](") {
          for (const target of this.db.iterTargets()) {
            completionItems.push({
              label: `${target.name}`,
              documentation: `${target.uri}::${target.line}`,
              kind: CompletionItemKind.Variable,
              data: "myst.targets"
            })
          }
        } else if (charsPreceding === "][") {
          for (const data of this.cache.iterDefs(
            textDocumentPosition.textDocument.uri,
            true
          )) {
            completionItems.push({
              label: data.key,
              kind: CompletionItemKind.Reference,
              documentation: data.href,
              data: "myst.definition"
            })
          }
        } else if (charsPreceding[1] == "{") {
          for (const name in roleDict) {
            completionItems.push({
              label: name,
              kind: CompletionItemKind.Function,
              data: "myst.role"
            })
          }
        }
      }
    }
    return completionItems
  }

  onHover(params: TextDocumentPositionParams): Hover | null {
    const doc = this.getDocument(params.textDocument.uri)
    const docData = this.cache.getData(params.textDocument.uri)
    if (!docData || !doc) {
      return null
    }

    const indexes = docData.lineToTokenIndex[params.position.line] || []

    for (const index of indexes) {
      const token = docData.tokens[index]

      if (!token.map) {
        continue
      }

      // Hover over a directive name
      if (
        (token.type === "fence" || token.type === "div_open") &&
        params.position.line === token.map[0]
      ) {
        const name = matchDirectiveName(doc, params)
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

  // This handler resolves additional information for the item selected in the completion list.
  onCompletionResolve(item: CompletionItem): CompletionItem {
    if (item.data === "myst.directive") {
      const dict: { [key: string]: { name: string } } = dirDict
      const data = dict[item.label]
      item.documentation = makeDescription(data)
    }
    return item
  }

  onSemanticTokens(params: SemanticTokensParams): SemanticTokens {
    // https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#textDocument_semanticTokens
    const data = this.cache.getData(params.textDocument.uri)
    const doc = this.getDocument(params.textDocument.uri)
    if (!data || !doc) {
      return {
        data: []
      }
    }
    // format is flattened [deltaLine, deltaStartChar, length, tokenType, tokenModifiers]
    const tokens: number[] = []
    let lastLine = 0
    for (const token of data.tokens) {
      if (!token.map) {
        continue
      }
      // color all directive names
      if (token.type === "fence" || token.type === "div_open") {
        const line = doc.getText({
          start: { line: token.map[0], character: 0 },
          end: { line: token.map[0], character: 1000 }
        })
        const match = line.match(/(`{3,}|~{3,}|:{3,}){([^}]+)}/)
        if (match) {
          tokens.push(
            token.map[0] - lastLine,
            (match.index || 0) + match[1].length + 1,
            match[2].length,
            0,
            0
          )
          lastLine = token.map[0]
        }
      }
      // color all myst_target names
      if (token.type === "myst_target") {
        const line = doc.getText({
          start: { line: token.map[0], character: 0 },
          end: { line: token.map[0], character: 1000 }
        })
        const match = line.match(/\(([^)]+)\)/)
        if (match) {
          tokens.push(
            token.map[0] - lastLine,
            (match.index || 0) + 1,
            match[1].length,
            1,
            1
          )
          lastLine = token.map[0]
        }
      }
    }
    return {
      data: tokens
    }
  }
}

new Server()
