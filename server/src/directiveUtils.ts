import { MarkupContent, MarkupKind } from "vscode-languageserver/node"
import * as yaml from "js-yaml"

import { TextDocumentPositionParams } from "vscode-languageserver/node"
import { IDocData } from "./server"
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
  docData: IDocData,
  textDocumentPosition: TextDocumentPositionParams
): boolean {
  const match = matchPositionText(
    docData.doc,
    textDocumentPosition.position,
    /(```|~~~|:::){$/,
    null
  )
  return !!match.before
}

/** Match position in the text to a directive name, e.g. ```{name} */
export function matchDirectiveName(
  docData: IDocData,
  params: TextDocumentPositionParams
): string | null {
  const match = matchPositionText(
    docData.doc,
    params.position,
    /(```|~~~|:::){(.*)$/,
    /^(.*)}/
  )
  if (match.before && match.after) {
    return match.before[2] + match.after[1]
  }
  return null
}
