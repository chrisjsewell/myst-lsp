/* --------------------------------------------------------------------------------------------
 * Licensed under the MIT License. See License file in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import {
  createConnection,
  TextDocuments,
  Diagnostic,
  DiagnosticSeverity,
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
  TextDocumentChangeEvent
} from "vscode-languageserver/node"

import { TextDocument } from "vscode-languageserver-textdocument"

// The example settings
interface ServerSettings {
  maxNumberOfProblems: number
}

class Server {
  connection: _Connection
  hasConfigurationCapability: boolean
  hasWorkspaceFolderCapability: boolean
  hasDiagnosticRelatedInformationCapability: boolean
  defaultSettings: ServerSettings
  globalSettings: ServerSettings
  documentSettings: Map<string, Thenable<ServerSettings>>
  documents: TextDocuments<TextDocument>

  constructor() {
    this.hasConfigurationCapability = false
    this.hasWorkspaceFolderCapability = false
    this.hasDiagnosticRelatedInformationCapability = false

    this.defaultSettings = { maxNumberOfProblems: 1000 }
    // The global settings, used when the `workspace/configuration` request is not supported by the client.
    this.globalSettings = this.defaultSettings
    // Cache the settings of all open documents
    this.documentSettings = new Map()

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
    })

    this.documents.onDidChangeContent(this.onDidChangeContent.bind(this))
    this.connection.onDidChangeWatchedFiles(this.onDidChangeWatchedFiles.bind(this))
    this.connection.onCompletion(this.onCompletion.bind(this))
    this.connection.onCompletionResolve(this.onCompletionResolve.bind(this))

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
          resolveProvider: true
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

  onInitialized() {
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

    // Revalidate all open text documents
    this.documents.all().forEach(this.validateTextDocument.bind(this))
  }

  async validateTextDocument(textDocument: TextDocument): Promise<void> {
    // In this simple example we get the settings for every validate run.
    const settings = await this.getDocumentSettings(textDocument.uri)

    // The validator creates diagnostics for all uppercase words length 2 and more
    const text = textDocument.getText()
    const pattern = /\b[A-Z]{2,}\b/g
    let m: RegExpExecArray | null

    let problems = 0
    const diagnostics: Diagnostic[] = []
    while ((m = pattern.exec(text)) && problems < settings.maxNumberOfProblems) {
      problems++
      const diagnostic: Diagnostic = {
        severity: DiagnosticSeverity.Warning,
        range: {
          start: textDocument.positionAt(m.index),
          end: textDocument.positionAt(m.index + m[0].length)
        },
        message: `${m[0]} is all uppercase.`,
        source: "ex"
      }
      if (this.hasDiagnosticRelatedInformationCapability) {
        diagnostic.relatedInformation = [
          {
            location: {
              uri: textDocument.uri,
              range: Object.assign({}, diagnostic.range)
            },
            message: "Spelling matters"
          },
          {
            location: {
              uri: textDocument.uri,
              range: Object.assign({}, diagnostic.range)
            },
            message: "Particularly for names"
          }
        ]
      }
      diagnostics.push(diagnostic)
    }

    // Send the computed diagnostics to VSCode.
    this.connection.sendDiagnostics({ uri: textDocument.uri, diagnostics })
  }

  // The content of a text document has changed. This event is emitted
  // when the text document first opened or when its content has changed.
  onDidChangeContent(change: TextDocumentChangeEvent<TextDocument>) {
    this.validateTextDocument(change.document)
  }

  // Monitored files have changed
  onDidChangeWatchedFiles(change: DidChangeWatchedFilesParams) {
    this.connection.console.log("We received a file change event")
  }

  // This handler provides the initial list of the completion items.
  onCompletion(textDocumentPosition: TextDocumentPositionParams): CompletionItem[] {
    // The pass parameter contains the position of the text document in
    // which code complete got requested. For the example we ignore this
    // info and always provide the same completion items.
    return [
      {
        label: "TypeScript",
        kind: CompletionItemKind.Text,
        data: 1
      },
      {
        label: "JavaScript",
        kind: CompletionItemKind.Text,
        data: 2
      }
    ]
  }

  // This handler resolves additional information for the item selected in
  // the completion list.
  onCompletionResolve(item: CompletionItem): CompletionItem {
    if (item.data === 1) {
      item.detail = "TypeScript details"
      item.documentation = "TypeScript documentation"
    } else if (item.data === 2) {
      item.detail = "JavaScript details"
      item.documentation = "JavaScript documentation"
    }
    return item
  }
}

new Server()
