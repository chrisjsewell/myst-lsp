import MarkdownIt = require("markdown-it")
import { isSpace, normalizeReference } from "markdown-it/lib/common/utils"
import StateBlock = require("markdown-it/lib/rules_block/state_block")

/** A reimplementation of markdown-it's definition parser,
 * but also stores the definitions as tokens.
 *
 * https://github.com/markdown-it/markdown-it/blob/13cdeb95abccc78a5ce17acf9f6e8cf5b9ce713b/lib/rules_block/reference.js#L1-L199
 */
export function definitionPlugin(md: MarkdownIt): void {
  md.block.ruler.at("reference", reference)
}

function reference(
  state: StateBlock,
  startLine: number,
  endLine: number,
  silent: boolean
): boolean {
  let ch,
    i,
    l,
    labelEnd,
    res,
    terminate,
    title,
    lines = 0,
    pos = state.bMarks[startLine] + state.tShift[startLine],
    max = state.eMarks[startLine],
    nextLine = startLine + 1

  // if it's indented more than 3 spaces, it should be a code block
  if (state.sCount[startLine] - state.blkIndent >= 4) {
    return false
  }

  if (state.src.charCodeAt(pos) !== 0x5b /* [ */) {
    return false
  }

  // Simple check to quickly interrupt scan on [link](url) at the start of line.
  // Can be useful on practice: https://github.com/markdown-it/markdown-it/issues/54
  while (++pos < max) {
    if (
      state.src.charCodeAt(pos) === 0x5d /* ] */ &&
      state.src.charCodeAt(pos - 1) !== 0x5c /* \ */
    ) {
      if (pos + 1 === max) {
        return false
      }
      if (state.src.charCodeAt(pos + 1) !== 0x3a /* : */) {
        return false
      }
      break
    }
  }

  endLine = state.lineMax

  // jump line-by-line until empty one or EOF
  const terminatorRules = state.md.block.ruler.getRules("reference")

  const oldParentType = state.parentType
  state.parentType = "reference"

  for (; nextLine < endLine && !state.isEmpty(nextLine); nextLine++) {
    // this would be a code block normally, but after paragraph
    // it's considered a lazy continuation regardless of what's there
    if (state.sCount[nextLine] - state.blkIndent > 3) {
      continue
    }

    // quirk for blockquotes, this line should already be checked by that rule
    if (state.sCount[nextLine] < 0) {
      continue
    }

    // Some tags can terminate paragraph without empty line.
    terminate = false
    for (i = 0, l = terminatorRules.length; i < l; i++) {
      if (terminatorRules[i](state, nextLine, endLine, true)) {
        terminate = true
        break
      }
    }
    if (terminate) {
      break
    }
  }

  const str = state.getLines(startLine, nextLine, state.blkIndent, false).trim()
  max = str.length

  for (pos = 1; pos < max; pos++) {
    ch = str.charCodeAt(pos)
    if (ch === 0x5b /* [ */) {
      return false
    } else if (ch === 0x5d /* ] */) {
      labelEnd = pos
      break
    } else if (ch === 0x0a /* \n */) {
      lines++
    } else if (ch === 0x5c /* \ */) {
      pos++
      if (pos < max && str.charCodeAt(pos) === 0x0a) {
        lines++
      }
    }
  }

  if (
    labelEnd === undefined ||
    labelEnd < 0 ||
    str.charCodeAt(labelEnd + 1) !== 0x3a /* : */
  ) {
    return false
  }

  // [label]:   destination   'title'
  //         ^^^ skip optional whitespace here
  for (pos = labelEnd + 2; pos < max; pos++) {
    ch = str.charCodeAt(pos)
    if (ch === 0x0a) {
      lines++
    } else if (isSpace(ch)) {
      /*eslint no-empty:0*/
    } else {
      break
    }
  }

  // [label]:   destination   'title'
  //            ^^^^^^^^^^^ parse this
  res = state.md.helpers.parseLinkDestination(str, pos, max)
  if (!res.ok) {
    return false
  }

  const href = state.md.normalizeLink(res.str)
  if (!state.md.validateLink(href)) {
    return false
  }

  pos = res.pos
  lines += res.lines

  // save cursor state, we could require to rollback later
  const destEndPos = pos
  const destEndLineNo = lines

  // [label]:   destination   'title'
  //                       ^^^ skipping those spaces
  const start = pos
  for (; pos < max; pos++) {
    ch = str.charCodeAt(pos)
    if (ch === 0x0a) {
      lines++
    } else if (isSpace(ch)) {
      /*eslint no-empty:0*/
    } else {
      break
    }
  }

  // [label]:   destination   'title'
  //                          ^^^^^^^ parse this
  res = state.md.helpers.parseLinkTitle(str, pos, max)
  if (pos < max && start !== pos && res.ok) {
    title = res.str
    pos = res.pos
    lines += res.lines
  } else {
    title = ""
    pos = destEndPos
    lines = destEndLineNo
  }

  // skip trailing spaces until the rest of the line
  while (pos < max) {
    ch = str.charCodeAt(pos)
    if (!isSpace(ch)) {
      break
    }
    pos++
  }

  if (pos < max && str.charCodeAt(pos) !== 0x0a) {
    if (title) {
      // garbage at the end of the line after title,
      // but it could still be a valid reference if we roll back
      title = ""
      pos = destEndPos
      lines = destEndLineNo
      while (pos < max) {
        ch = str.charCodeAt(pos)
        if (!isSpace(ch)) {
          break
        }
        pos++
      }
    }
  }

  if (pos < max && str.charCodeAt(pos) !== 0x0a) {
    // garbage at the end of the line
    return false
  }

  const labelRaw = str.slice(1, labelEnd)
  const labelNorm = normalizeReference(labelRaw)
  if (!labelNorm) {
    // CommonMark 0.20 disallows empty labels
    return false
  }

  // Reference can not terminate anything. This check is for safety only.
  if (silent) {
    return true
  }

  const token = state.push("definition", "", 0)
  token.map = [startLine, startLine + lines]
  token.meta = { title: title, href: href, raw: labelRaw, key: labelNorm }

  if (typeof state.env.references === "undefined") {
    state.env.references = {}
  }
  if (typeof state.env.references[labelNorm] === "undefined") {
    state.env.references[labelNorm] = { title: title, href: href }
  }

  state.parentType = oldParentType

  state.line = startLine + lines + 1
  return true
}
