import { Position } from "vscode-languageserver"
import { TextDocument } from "vscode-languageserver-textdocument"

// match either side of a position in a document
// @param doc: The document to match in
// @param position: The position in the document
// @param startMatch: The match to find, upto and including the position
// @param endMatch: The match to find, from the position
export function matchPositionText(
  doc: TextDocument,
  position: Position,
  beforeRgx: RegExp | null,
  afterRgx: RegExp | null
): { before: RegExpMatchArray | null; after: RegExpMatchArray | null } {
  const match: { before: RegExpMatchArray | null; after: RegExpMatchArray | null } = {
    before: null,
    after: null
  }
  if (beforeRgx) {
    const startText = doc.getText({
      start: { line: position.line, character: 0 },
      end: position
    })
    match.before = startText.match(beforeRgx)
  }
  if (afterRgx) {
    const endText = doc.getText({
      start: position,
      end: { line: position.line, character: 9999 }
    })
    match.after = endText.match(afterRgx)
  }
  return match
}
