import MarkdownIt = require("markdown-it")
import StateBlock = require("markdown-it/lib/rules_block/state_block")
import yaml from "js-yaml"

export function mystDivPlugin(md: MarkdownIt): void {
  md.block.ruler.before("fence", "div", parseDiv, {
    alt: ["paragraph", "reference", "blockquote", "list"]
  })
}

function parseDiv(
  state: StateBlock,
  startLine: number,
  endLine: number,
  silent: boolean
): boolean {
  const min_markers = 3,
    marker_str = ":",
    marker_char = marker_str.charCodeAt(0),
    marker_len = marker_str.length,
    colonCharCode = ":".charCodeAt(0)

  let pos,
    nextLine,
    token,
    auto_closed = false,
    start = state.bMarks[startLine] + state.tShift[startLine],
    max = state.eMarks[startLine]

  // Check out the first character quickly,
  // this should filter out most of non-containers
  if (marker_char !== state.src.charCodeAt(start)) {
    return false
  }

  // Check out the rest of the marker string
  for (pos = start + 1; pos <= max; pos++) {
    if (marker_str[(pos - start) % marker_len] !== state.src[pos]) {
      break
    }
  }

  const marker_count = Math.floor((pos - start) / marker_len)
  if (marker_count < min_markers) {
    return false
  }
  pos -= (pos - start) % marker_len

  const markup = state.src.slice(start, pos)
  const params = state.src.slice(pos, max)

  // Since start is found, we can report success here in validation mode
  //
  if (silent) {
    return true
  }

  // Search for the end of the block
  //
  nextLine = startLine

  // identify the option lines
  let inOptions = true
  let optionsEndLine: number | null = null

  for (;;) {
    nextLine++
    if (nextLine >= endLine) {
      // unclosed block should be auto-closed by end of document.
      // also block seems to be auto-closed by end of parent
      break
    }

    start = state.bMarks[nextLine] + state.tShift[nextLine]
    max = state.eMarks[nextLine]

    if (start < max && state.sCount[nextLine] < state.blkIndent) {
      // non-empty line with negative indent should stop the list:
      // - ```
      //  test
      break
    }

    if (
      inOptions &&
      colonCharCode === state.src.charCodeAt(start) &&
      colonCharCode !== state.src.charCodeAt(start + 1) &&
      state.sCount[nextLine] - state.blkIndent <= 3
    ) {
      optionsEndLine = nextLine
    } else {
      inOptions = false
    }

    if (marker_char !== state.src.charCodeAt(start)) {
      continue
    }

    if (state.sCount[nextLine] - state.blkIndent >= 4) {
      // closing fence should be indented less than 4 spaces
      continue
    }

    for (pos = start + 1; pos <= max; pos++) {
      if (marker_str[(pos - start) % marker_len] !== state.src[pos]) {
        break
      }
    }

    // closing code fence must be at least as long as the opening one
    if (Math.floor((pos - start) / marker_len) < marker_count) {
      continue
    }

    // make sure tail has spaces only
    pos -= (pos - start) % marker_len
    pos = state.skipSpaces(pos)

    if (pos < max) {
      continue
    }

    // found!
    auto_closed = true
    break
  }

  const old_parent = state.parentType
  const old_line_max = state.lineMax
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  state.parentType = "div"

  // this will prevent lazy continuations from ever going past our end marker
  state.lineMax = nextLine

  token = state.push("div_open", "div", 1)
  token.markup = markup
  token.block = true
  token.info = params
  token.map = [startLine, nextLine]
  if (optionsEndLine) {
    let optText = state.getLines(
      startLine + 1,
      optionsEndLine + 1,
      state.blkIndent,
      false
    )
    optText = optText
      .split("\n")
      .map(line => line.replace(/^\s+/, "").slice(1))
      .join("\n")
    token.meta = { optMap: [startLine + 1, optionsEndLine] }
    try {
      const options = yaml.load(optText)
      if (typeof options !== "object") {
        throw new Error("Options must be a dictionary")
      }
      token.meta.options = options
    } catch (err) {
      token.meta.optError = `${err}`
    }
    startLine = optionsEndLine
  }

  state.md.block.tokenize(state, startLine + 1, nextLine)

  token = state.push("div_close", "div", -1)
  token.markup = state.src.slice(start, pos)
  token.block = true

  state.parentType = old_parent
  state.lineMax = old_line_max
  state.line = nextLine + (auto_closed ? 1 : 0)

  return true
}
