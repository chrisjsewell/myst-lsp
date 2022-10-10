import { MarkupContent, MarkupKind } from "vscode-languageserver/node"
import * as yaml from "js-yaml"

import { TextDocumentPositionParams } from "vscode-languageserver/node"
import { IDocData } from "./server"

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
  docData: IDocData,
  textDocumentPosition: TextDocumentPositionParams
): RegExpMatchArray | null {
  const startText = docData.doc.getText({
    start: { line: textDocumentPosition.position.line, character: 0 },
    end: textDocumentPosition.position
  })
  return startText.match(/(```|~~~|:::){$/)
}

/** Match position in the text to a directive name, e.g. ```{name} */
export function matchDirectiveName(
  docData: IDocData,
  params: TextDocumentPositionParams
): string | null {
  const startText = docData.doc.getText({
    start: { line: params.position.line, character: 0 },
    end: params.position
  })
  const endText = docData.doc.getText({
    start: params.position,
    end: { line: params.position.line, character: 9999 }
  })
  const matchStart = startText.match(/(```|~~~|:::){(.*)$/)
  const matchEnd = endText.match(/^(.*)}/)
  if (matchStart && matchEnd) {
    return matchStart[2] + matchEnd[1]
  }
  return null
}
