#!/usr/bin/env node
/* --------------------------------------------------------------------------------------------
 * Licensed under the MIT License. See License file in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import glob from "fast-glob"
import fs from "fs"
import yaml from "js-yaml"
import { validate } from "jsonschema"
import loki from "lokijs"
import MarkdownIt from "markdown-it"
import Token from "markdown-it/lib/token"
import frontMatterPlugin from "markdown-it-front-matter"
import path from "path"
import url from "url"
import { NotebookDocumentChangeEvent } from "vscode-languageserver/lib/common/notebook"
import {
  _Connection,
  CompletionItem,
  CompletionItemKind,
  createConnection,
  Definition,
  DefinitionParams,
  DidChangeWatchedFilesParams,
  FileChangeType,
  FoldingRange,
  FoldingRangeParams,
  Hover,
  InitializedParams,
  InitializeParams,
  InitializeResult,
  NotebookDocument,
  NotebookDocuments,
  Position,
  ProposedFeatures,
  SemanticTokens,
  SemanticTokensParams,
  TextDocumentChangeEvent,
  TextDocumentPositionParams,
  TextDocuments,
  TextDocumentSyncKind,
  TextEdit
} from "vscode-languageserver/node"
import { TextDocument } from "vscode-languageserver-textdocument"
import { URI } from "vscode-uri"

import * as dirDict from "./directives.json"
import {
  makeDescription,
  matchDirectiveName,
  matchDirectiveStart
} from "./directiveUtils"
import { divPlugin } from "./mdPluginDiv"
import { mystBlocksPlugin } from "./mdPluginMyst"
import * as roleDict from "./roles.json"
import { getLine, matchReferenceLink } from "./utils"

interface ServerConfig {
  files: {
    text: string[]
    jupyter: string[]
    ignore: string[]
  }
  parsing: {
    /** Markdown-it extensions */
    extensions: string[]
  }
  lsp: {
    /** The tokens to apply folding to */
    foldingTokens: string[]
  }
}

interface ITargetData {
  uri: string
  name: string
  line: number
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
  private data: Map<string, ICacheData>
  // map of parentUri to set of childUris
  // used for cells of a notebook
  private parentToChildUri: Map<string, Set<string>>

  constructor() {
    this.data = new Map()
    this.parentToChildUri = new Map()
  }

  removeUri(uri: string) {
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
    })
    this.parentToChildUri.delete(uri)
  }

  clear() {
    this.data.clear()
  }

  setParentToChildUri(parentUri: string, childUri: string) {
    if (!this.parentToChildUri.has(parentUri)) {
      this.parentToChildUri.set(parentUri, new Set())
    }
    this.parentToChildUri.get(parentUri)?.add(childUri)
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
  clear() {
    this.targets.clear()
  }
  removeUri(uri: string) {
    this.targets.findAndRemove({ uri })
  }
  insertTargets(targets: ITargetData[]) {
    this.targets.insert(targets)
  }
  getTargets(name: string): ITargetData[] {
    return this.targets.find({ name })
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
  // Store client side information provided on initialization (e.g. capabilities)
  clientParams: InitializeParams
  // specific client side capabilities
  clientCapabilities: {
    workspacesFolders: boolean
    diagnosticRelatedInfo: boolean
  }
  // open documents managers
  documents: TextDocuments<TextDocument>
  notebooks: NotebookDocuments<TextDocument>
  // the cache stores data for only open documents
  cache: DocCache
  // the database stores data for the whole project
  db: projectDatabase

  // the current configuration, based on defaults and user settings
  config: ServerConfig

  constructor() {
    this.config = this.getDefaultConfig().defaults

    this.clientCapabilities = {
      workspacesFolders: false,
      diagnosticRelatedInfo: false
    }
    this.clientParams = {} as InitializeParams

    this.cache = new DocCache()
    this.db = new projectDatabase()

    // Create a connection for the server, using Node's IPC as a transport.
    // Also include all preview / proposed LSP features.
    this.connection = createConnection(ProposedFeatures.all)
    // Create a simple text document manager.
    this.documents = new TextDocuments(TextDocument)
    this.notebooks = new NotebookDocuments(TextDocument)

    this.connection.onInitialize(this.onInitialize.bind(this))
    this.connection.onInitialized(this.onInitialized.bind(this))

    // text document synchronisation
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
    this.connection.onDefinition(this.onDefinition.bind(this))
    this.connection.languages.semanticTokens.on(this.onSemanticTokens.bind(this))

    // Make the text document managers listen on the connection
    // for open, change and close text document events
    this.documents.listen(this.connection)
    this.notebooks.listen(this.connection)

    // Listen on the connection
    this.connection.listen()
  }

  getDefaultConfig(): { defaults: ServerConfig; schema: any } {
    return {
      defaults: {
        files: {
          text: ["**/*.md"],
          jupyter: ["**/*.ipynb"],
          ignore: [
            "**/node_modules/**",
            "**/.git/**",
            "**/.tox/**",
            "**/.venv/**",
            "**/_build/**"
          ]
        },
        parsing: {
          extensions: ["colon_fence"]
        },
        lsp: {
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
      },
      schema: {
        type: "object",
        properties: {
          files: {
            type: "object",
            properties: {
              text: {
                type: "array",
                items: {
                  type: "string"
                }
              },
              jupyter: {
                type: "array",
                items: {
                  type: "string"
                }
              },
              ignore: {
                type: "array",
                items: {
                  type: "string"
                }
              }
            }
          },
          parsing: {
            type: "object",
            properties: {
              extensions: {
                type: "array",
                items: {
                  type: "string"
                }
              }
            }
          },
          lsp: {
            type: "object",
            properties: {
              foldingTokens: {
                type: "array",
                items: {
                  type: "string"
                }
              }
            }
          }
        }
      }
    }
  }

  async updateConfig(newConfig: any) {
    const { defaults, schema } = this.getDefaultConfig()
    const result = validate(newConfig, schema)
    if (!result.valid) {
      this.connection.console.error(`Invalid configuration: ${result.errors}`)
      return
    }
    for (const [sectionKey, section] of Object.entries(newConfig)) {
      if (sectionKey in defaults) {
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        const defaultSection = defaults[sectionKey]
        for (const [key, value] of Object.entries(section as object)) {
          if (key in defaultSection) {
            defaultSection[key] = value
          }
        }
      }
    }
    let requiresReanalysis = false
    if (defaults.files !== this.config.files) {
      requiresReanalysis = true
    }
    if (defaults.parsing.extensions !== this.config.parsing.extensions) {
      requiresReanalysis = true
    }
    this.config = defaults
    if (requiresReanalysis) {
      await this.analyzeProject()
    }
  }

  onInitialize(params: InitializeParams) {
    this.clientParams = params

    // Check what capabilities the client supports
    const capabilities = params.capabilities
    this.clientCapabilities.workspacesFolders = !!(
      capabilities.workspace && !!capabilities.workspace.workspaceFolders
    )
    this.clientCapabilities.diagnosticRelatedInfo = !!(
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
        definitionProvider: true,
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
    if (this.clientCapabilities.workspacesFolders) {
      // TODO add support for workspace folders (e.g. when analysing projects)
      //   result.capabilities.workspace = {
      //     workspaceFolders: {
      //       supported: true
      //     }
      //   }
    }

    return result
  }

  async onInitialized(params: InitializedParams) {
    // set up file watcher for configuration file
    // Note here we use our own config file rather than one supplied by the client
    // because we want to have a single config work for all clients, and also all myst tools in general
    // we also could have the client watch the file: https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#workspace_didChangeWatchedFiles
    // however, in particular jupyterlab-lsp does not support this yet
    // TODO use the client's file watcher, if the client supports it
    if (this.clientParams.rootUri) {
      const watcher = fs.watchFile(
        path.join(url.fileURLToPath(this.clientParams.rootUri), "myst.yml"),
        async (curr: fs.Stats, prev: fs.Stats) => {
          // check if file deleted
          let newConfig: any = {}
          if (
            curr.size !== 0 &&
            curr.mtime !== prev.mtime &&
            this.clientParams.rootUri
          ) {
            try {
              newConfig = yaml.load(
                fs.readFileSync(
                  path.join(url.fileURLToPath(this.clientParams.rootUri), "myst.yml"),
                  "utf8"
                )
              ) as any
            } catch (e) {
              this.connection.console.error(`Reading myst.yml failed: ${e}`)
            }
          }
          this.updateConfig(newConfig)
        }
      )
    }
    await this.analyzeProject()
  }

  async analyzeProject() {
    // TODO support multiple workfolders
    const rootUri = this.clientParams.rootUri
    this.connection.console.log(`Starting analysing project: ${rootUri}`)
    if (!rootUri) {
      return
    }
    if (!rootUri.startsWith("file://")) {
      this.connection.console.warn(
        "Only local files are supported for project analysis"
      )
      return
    }

    const rootPath = url.fileURLToPath(rootUri)
    // check if the root path is a directory
    if (!fs.statSync(rootPath).isDirectory()) {
      this.connection.console.warn(
        "Only local directories are supported for project analysis"
      )
      return
    }

    // glob all text based files relative to the root path
    const filesText = await glob(this.config.files.text, {
      cwd: rootPath,
      absolute: true,
      ignore: this.config.files.ignore
    })
    // glob all jupyter notebook based files relative to the root path
    const filesNb = await glob(this.config.files.jupyter, {
      cwd: rootPath,
      absolute: true,
      ignore: this.config.files.ignore
    })
    const numFiles = filesText.length + filesNb.length

    const progress = await this.connection.window.createWorkDoneProgress()
    progress.begin("MyST LSP", 0, "Analysing Project")
    this.db.clear()
    for await (const [index, file] of filesText.entries()) {
      progress.report((index / numFiles) * 100, "Analysing Project")
      const content = fs.readFileSync(file, "utf-8")
      const doc = TextDocument.create(URI.file(file).toString(), "markdown", 0, content)
      const data = this.parseTextDocument(doc)
      this.db.insertTargets(data.targets)
    }
    for await (const [index, file] of filesNb.entries()) {
      progress.report(
        ((filesText.length + index) / numFiles) * 100,
        "Analysing Project"
      )
      const content = fs.readFileSync(file, "utf-8")
      const cells = JSON.parse(content).cells as {
        cell_type: string
        source: string[]
      }[]
      cells.forEach((cell, index) => {
        if (cell.cell_type === "markdown") {
          let uri = URI.file(file)
          if (this.clientParams.clientInfo?.name === "Visual Studio Code") {
            // see: https://github.com/microsoft/language-server-protocol/issues/1399
            uri = cellUriGenerate(URI.file(file), index)
          }
          const doc = TextDocument.create(
            uri.toString(),
            "markdown",
            0,
            cell.source.join("")
          )
          const data = this.parseTextDocument(doc)
          this.db.insertTargets(data.targets)
        }
      })
    }
    progress.done()

    this.connection.console.log(`Finished analysing project: ${rootUri}`)
  }

  // analyse an open text document, and store the result in the cache
  async analyseTextDocument(textDocument: TextDocument): Promise<void> {
    this.db.removeUri(textDocument.uri)
    this.cache.removeUri(textDocument.uri)
    const data = this.parseTextDocument(textDocument)
    this.cache.setData(textDocument.uri, {
      tokens: data.tokens,
      lineToTokenIndex: data.lineToTokenIndex,
      defs: data.definitions
    })
    this.db.insertTargets(data.targets)
  }

  /** Parse a text document
   *
   * @param textDocument The text document to parse
   */
  parseTextDocument(textDocument: TextDocument): {
    tokens: Token[]
    lineToTokenIndex: number[][]
    definitions: IDefinition[]
    targets: ITargetData[]
  } {
    // The validator creates diagnostics for all uppercase words length 2 and more
    const text = textDocument.getText()

    const md = new MarkdownIt("commonmark", {})
    md.use(mystBlocksPlugin)
    if (this.config.parsing.extensions.includes("colon_fence")) {
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
    const definitions = Object.entries(env.references).map(([k, v]) => {
      return { key: k, href: v.href, title: v.title }
    })
    const targets = tokens
      .filter(t => t.type === "myst_target" && t.map)
      .map(t => {
        return {
          name: t.content,
          uri: textDocument.uri,
          line: t.map ? t.map[0] : 0
        }
      })
    return {
      tokens,
      lineToTokenIndex,
      definitions,
      targets
    }
  }

  onDocOpen(change: TextDocumentChangeEvent<TextDocument>) {
    // doc open also triggers onDocChange, so nothing to do here
  }

  onDocChange(change: TextDocumentChangeEvent<TextDocument>) {
    this.analyseTextDocument(change.document)
  }

  onNbOpen(nb: NotebookDocument) {
    for (const cell of nb.cells) {
      const cellDoc = this.notebooks.getCellTextDocument(cell)
      if (cellDoc) {
        this.analyseTextDocument(cellDoc)
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
      this.db.removeUri(cell.document)
    }
    for (const cell of change.cells.added) {
      const cellDoc = this.notebooks.getCellTextDocument(cell)
      if (cellDoc) {
        this.analyseTextDocument(cellDoc)
        this.cache.setParentToChildUri(change.notebookDocument.uri, cellDoc.uri)
      }
    }
    for (const cell of change.cells.changed.textContent) {
      const cellDoc = this.notebooks.getCellTextDocument(cell)
      if (cellDoc) {
        this.analyseTextDocument(cellDoc)
      }
    }
  }

  // Monitored files have changed
  onDidChangeWatchedFiles(change: DidChangeWatchedFilesParams) {
    // TODO not currently used
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

  onFoldingRanges(params: FoldingRangeParams): FoldingRange[] {
    const textDocument = this.getDocument(params.textDocument.uri)
    if (!textDocument) {
      return []
    }
    const foldingRanges: FoldingRange[] = []
    for (const token of this.cache.getData(textDocument.uri)?.tokens || []) {
      if (token.map && this.config.lsp.foldingTokens.includes(token.type)) {
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
    const doc = this.getDocument(textDocumentPosition.textDocument.uri)
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
        const matchDir = matchDirectiveStart(doc, textDocumentPosition)
        if (matchDir) {
          for (const name in dirDict) {
            if (name.startsWith(matchDir.partial)) {
              completionItems.push({
                label: name,
                kind: CompletionItemKind.Class,
                detail: "MyST directive",
                data: "myst.directive",
                textEdit: completetionTextEdit(
                  name,
                  matchDir.partial,
                  textDocumentPosition.position
                )
              })
            }
          }
        }
      } else if (token.type === "inline") {
        const line = getLine(doc, textDocumentPosition.position.line)
        completionItems.push(
          ...this.completeInlineCursor(
            textDocumentPosition.textDocument.uri,
            textDocumentPosition.position,
            line
          )
        )
      }
    }
    return completionItems
  }

  /** Identify possible completions for a cursor in an inline block */
  *completeInlineCursor(
    uri: string,
    cursor: Position,
    content: string
  ): IterableIterator<CompletionItem> {
    const before: string = content.slice(0, cursor.character)

    const matchRefLink = before.match(/\]\([<]?([^(]*)$/)
    if (matchRefLink) {
      const start = matchRefLink[1]
      for (const target of this.db.iterTargets()) {
        if (target.name.startsWith(start)) {
          yield {
            label: target.name,
            kind: CompletionItemKind.Reference,
            detail: "MyST target",
            data: "myst.target",
            textEdit: completetionTextEdit(target.name, start, cursor)
          }
        }
      }
      return
    }

    const matchDefLink = before.match(/\]\[([^[]*)$/)
    if (matchDefLink) {
      const start = matchDefLink[1]
      for (const data of this.cache.iterDefs(uri, true)) {
        yield {
          label: data.key,
          kind: CompletionItemKind.Reference,
          detail: "MyST definition",
          documentation: data.href,
          data: "myst.definition",
          textEdit: completetionTextEdit(data.key, start, cursor)
        }
      }
      return
    }

    const matchRole = before.match(/\{([a-zA-Z0-9:_-]*)$/)
    if (matchRole) {
      const start = matchRole[1]
      for (const name in roleDict) {
        if (name.startsWith(start)) {
          yield {
            label: name,
            kind: CompletionItemKind.Function,
            detail: "MyST role",
            data: "myst.role",
            textEdit: completetionTextEdit(name, start, cursor)
          }
        }
      }
      return
    }
  }

  onCompletionResolve(item: CompletionItem): CompletionItem {
    if (item.data === "myst.directive") {
      const dict: { [key: string]: { name: string } } = dirDict
      const data = dict[item.label]
      item.documentation = makeDescription(data)
    }
    return item
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

  onDefinition(params: DefinitionParams): Definition | null {
    const doc = this.getDocument(params.textDocument.uri)
    if (!doc) {
      return null
    }
    const match = matchReferenceLink(doc, params.position)
    if (!match) {
      return null
    }
    const targets = this.db.getTargets(match.text)
    const defs = []
    for (const target of targets) {
      defs.push({
        uri: target.uri,
        range: {
          start: {
            line: target.line,
            character: 0
          },
          end: {
            line: target.line,
            character: 10000
          }
        }
      })
    }
    return defs
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
        const line = getLine(doc, token.map[0])
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
        const line = getLine(doc, token.map[0])
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

function completetionTextEdit(
  text: string,
  partial: string,
  cursor: Position
): TextEdit {
  return {
    newText: text,
    range: {
      start: {
        line: cursor.line,
        character: cursor.character - partial.length
      },
      end: cursor
    }
  }
}

const _lengths = ["W", "X", "Y", "Z", "a", "b", "c", "d", "e", "f"]
const _radix = 7

/** adapted from https://github.com/microsoft/vscode/blob/990cc855de8b8b695b6acc086006904caa35434d/src/vs/workbench/contrib/notebook/common/notebookCommon.ts */
function cellUriGenerate(notebook: URI, index: number): URI {
  const s = index.toString(_radix)
  const p = s.length < _lengths.length ? _lengths[s.length - 1] : "z"

  const fragment = `${p}${s}s${Buffer.from(notebook.scheme).toString("base64")}`
  return notebook.with({ scheme: "vscode-notebook-cell", fragment })
}

new Server()
