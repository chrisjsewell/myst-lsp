import { MarkupContent, MarkupKind } from "vscode-languageserver/node"
import { TextDocumentPositionParams } from "vscode-languageserver/node"
import { TextDocument } from "vscode-languageserver-textdocument"
import * as yaml from "js-yaml"

import { matchPositionText } from "./utils"

/** Make a markdown description for a directive */
export function makeDescription(data: any): MarkupContent {
  const opts = yaml.dump({
    "Required Args": data["required_arguments"],
    "Optional Args": data["optional_arguments"],
    "Has Content": data["has_content"],
    Options: data["options"]
  })
  return {
    value: `${data["description"]}\n\n\`\`\`yaml\n${opts}\`\`\``,
    kind: MarkupKind.Markdown
  }
}

/** Match the start of a directive */
export function matchDirectiveStart(
  doc: TextDocument,
  textDocumentPosition: TextDocumentPositionParams
): boolean {
  const match = matchPositionText(
    doc,
    textDocumentPosition.position,
    /(```|~~~|:::){$/,
    null
  )
  return !!match.before
}

/** Match position in the text to a directive name, e.g. ```{name} */
export function matchDirectiveName(
  doc: TextDocument,
  params: TextDocumentPositionParams
): string | null {
  const match = matchPositionText(doc, params.position, /(```|~~~|:::){(.*)$/, /^(.*)}/)
  if (match.before && match.after) {
    return match.before[2] + match.after[1]
  }
  return null
}
