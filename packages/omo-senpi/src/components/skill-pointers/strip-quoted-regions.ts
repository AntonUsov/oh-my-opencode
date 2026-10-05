const INJECTED_BLOCK = /<(omo-[a-z0-9-]+-pointer|ultrawork-mode|omo-ultrawork-reminder)>[\s\S]*?<\/\1>/gi
const INLINE_CODE = /(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g
// A message relayed from another session opens with a sender header: a bracketed tag such as `[REPORT]` or
// `[a -> b]`, or `Name (id), recipient:`. Everything in it is someone else's text, so none of it is a request.
const RELAY_HEADER = /^\s*(?:\[(?:[A-Z][A-Z0-9_-]{2,}|[\w.-]+ -> [\w.-]+)\]|[A-Z][\w.-]{0,30} \([^()\s]{1,40}\), [\w.-]{1,40}:)/
const BLOCK_QUOTE_LINE = /^ {0,3}>[^\n]*/gm
const DOUBLE_QUOTED = /"[^"\n]*"|\u201C[^\u201D\n]*\u201D/g

// Preserve offsets for the ultrawork /skill: argument check. Non-whitespace masking also prevents
// a skill name from being fabricated across removed text, such as "ulw `not a request` loop".
function mask(region: string): string {
  return region.replace(/[^\r\n]/g, "\0")
}

export function stripQuotedRegions(text: string): string {
  if (RELAY_HEADER.test(text)) return mask(text)
  let visible = text.replace(INJECTED_BLOCK, mask)
  const fenceStart = /^ {0,3}(`{3,}|~{3,})[^\n]*(?:\n|$)/gm
  while (true) {
    const opening = fenceStart.exec(visible)
    if (opening === null) break
    const fence = opening[1]
    const fenceEnd = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*\\r?$`, "gm")
    fenceEnd.lastIndex = fenceStart.lastIndex
    const closing = fenceEnd.exec(visible)
    const end = closing === null ? visible.length : fenceEnd.lastIndex
    visible = visible.slice(0, opening.index) + mask(visible.slice(opening.index, end)) + visible.slice(end)
    fenceStart.lastIndex = end
  }
  return visible.replace(INLINE_CODE, mask).replace(BLOCK_QUOTE_LINE, mask).replace(DOUBLE_QUOTED, mask)
}
