import { Position } from "vscode-languageserver"
import { TextDocument } from "vscode-languageserver-textdocument"

/** get content of line in document */
export function getLine(doc: TextDocument, line: number): string {
  return doc.getText({
    start: {
      line: line,
      character: 0
    },
    end: {
      line: line,
      character: 10000 // TODO better way than this?
    }
  })
}

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

/** match a cursor within a reference [text](reference) */
export function matchReferenceLink(
  doc: TextDocument,
  cursor: Position
): null | { text: string; range: { start: Position; end: Position } } {
  let match = matchPositionText(
    doc,
    cursor,
    /(\]\(\s*)([^<()\s][^()\s]*)$/,
    /^([^()\s]*)\s*(\)|\s")/
  )
  if (!match.before || !match.after) {
    // try again with a braced [text](<refere nce> ) which allows spaces
    match = matchPositionText(
      doc,
      cursor,
      /(\]\(\s*<)([^<>]*)$/,
      /^([^<>]*)>\s*(\)|\s")/
    )
  }
  // TODO backslash escapes, titles
  if (match.before && match.after && match.before.index) {
    const text = match.before[2] + match.after[1]
    if (!text) {
      return null
    }
    return {
      text,
      range: {
        start: {
          line: cursor.line,
          character: match.before.index + match.before[1].length
        },
        end: {
          line: cursor.line,
          character:
            match.before.index +
            match.before[1].length +
            match.before[2].length +
            match.after[1].length
        }
      }
    }
  }
  return null
}
