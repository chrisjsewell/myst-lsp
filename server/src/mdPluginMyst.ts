/** Local markdown-it plugins */
import MarkdownIt = require("markdown-it")
import StateBlock = require("markdown-it/lib/rules_block/state_block")

/** Parse MyST targets (``(name)=``), blockquotes (``% comment``) and block breaks (``+++``).
 *
 * Adapted from: mdit_py_plugins/myst_blocks/index.py
 */
export function mystBlocksPlugin(md: MarkdownIt): void {
  md.block.ruler.before("blockquote", "myst_line_comment", parse_line_comment, {
    alt: ["paragraph", "reference", "blockquote", "list", "footnote_def"]
  })
  md.block.ruler.before("hr", "myst_block_break", parse_block_break, {
    alt: ["paragraph", "reference", "blockquote", "list", "footnote_def"]
  })
  md.block.ruler.before("hr", "myst_target", parse_target, {
    alt: ["paragraph", "reference", "blockquote", "list", "footnote_def"]
  })
}

function parse_line_comment(
  state: StateBlock,
  startLine: number,
  endLine: number,
  silent: boolean
): boolean {
  let pos = state.bMarks[startLine] + state.tShift[startLine]
  let maximum = state.eMarks[startLine]

  // if it's indented more than 3 spaces, it should be a code block
  if (state.sCount[startLine] - state.blkIndent >= 4) {
    return false
  }

  if (state.src[pos] !== "%") {
    return false
  }

  if (silent) {
    return true
  }

  const token = state.push("myst_line_comment", "", 0)
  token.attrSet("class", "myst-line-comment")
  token.content = state.src.slice(pos + 1, maximum).replace(/\s+$/gm, "") // rstrip
  token.markup = "%"

  // search end of block while appending lines to `token.content`
  let nextLine: number
  for (nextLine = startLine + 1; nextLine < endLine; nextLine++) {
    pos = state.bMarks[nextLine] + state.tShift[nextLine]
    maximum = state.eMarks[nextLine]
    if (state.src[pos] !== "%") {
      break
    }
    token.content += "\n" + state.src.slice(pos + 1, maximum).replace(/\s+$/gm, "") // rstrip
  }
  state.line = nextLine
  token.map = [startLine, nextLine]

  return true
}

function parse_block_break(
  state: StateBlock,
  startLine: number,
  endLine: number,
  silent: boolean
): boolean {
  let pos = state.bMarks[startLine] + state.tShift[startLine]
  const maximum = state.eMarks[startLine]

  // if it's indented more than 3 spaces, it should be a code block
  if (state.sCount[startLine] - state.blkIndent >= 4) {
    return false
  }

  const marker = state.src.charCodeAt(pos)
  pos += 1

  // Check block marker /* + */
  if (marker !== 0x2b) {
    return false
  }

  // markers can be mixed with spaces, but there should be at least 3 of them

  let cnt = 1
  while (pos < maximum) {
    const ch = state.src.charCodeAt(pos)
    if (ch !== marker && !state.md.utils.isSpace(ch)) {
      break
    }
    if (ch === marker) {
      cnt += 1
    }
    pos += 1
  }

  if (cnt < 3) {
    return false
  }

  if (silent) {
    return true
  }

  state.line = startLine + 1

  const token = state.push("myst_block_break", "hr", 0)
  token.attrSet("class", "myst-block")
  token.content = state.src.slice(pos, maximum).trim()
  token.map = [startLine, state.line]
  token.markup = state.md.utils.fromCodePoint(marker).repeat(cnt)

  return true
}

const TARGET_PATTERN = /^\((?<label>[a-zA-Z0-9|@<>*./_\-+:]{1,100})\)=\s*$/

function parse_target(
  state: StateBlock,
  startLine: number,
  endLine: number,
  silent: boolean
): boolean {
  const pos = state.bMarks[startLine] + state.tShift[startLine]
  const maximum = state.eMarks[startLine]

  // if it's indented more than 3 spaces, it should be a code block
  if (state.sCount[startLine] - state.blkIndent >= 4) {
    return false
  }
  const match = TARGET_PATTERN.exec(state.src.slice(pos, maximum))
  if (!match) {
    return false
  }
  if (silent) {
    return true
  }

  state.line = startLine + 1

  const token = state.push("myst_target", "", 0)
  token.attrSet("class", "myst-target")
  token.content = match && match.groups ? match.groups["label"] : ""
  token.map = [startLine, state.line]

  return true
}
