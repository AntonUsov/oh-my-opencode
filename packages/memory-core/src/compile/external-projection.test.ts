import { describe, expect, it } from "bun:test"
import { renderExternalProjection, renderExternalProjectionStats } from "./index"

const at = (entries: Record<string, number>): ReadonlyMap<string, number> => new Map(Object.entries(entries))
const bytes = (text: string): number => Buffer.byteLength(text)

describe("renderExternalProjection limits", () => {
  it("#given a per-directory cap #when rendered #then the newest names show and the rest are counted with a pointer", () => {
    // given
    const paths = ["dir/c1.md", "dir/c2.md", "dir/c3.md"]
    const times = at({ "dir/c1.md": 1, "dir/c2.md": 2, "dir/c3.md": 3 })

    // when
    const text = renderExternalProjection(paths, { times, limits: { maxEntriesPerDirectory: 2, maxBytes: 0 } })

    // then
    expect(text.split("\n")).toContain("dir/: c3.md, c2.md (+1 more; read $MEMORY_DIR/dir/ to list)")
  })

  it("#given both limits disabled #when rendered #then the bytes equal the unbounded renderer's", () => {
    // given
    const paths = [
      "ARCHIVE.md", "reference/zeta.md", "reference/Alpha.md", "reference/project/b.md", "reference/project/a.md",
      "people/한글/card.md", "notes/n.md", "reference/AKIAABCDEFGHIJKLMNOP.md",
    ]
    const unbounded = "<external_projection>\n$MEMORY_DIR/: ARCHIVE.md\nnotes/: n.md\npeople/한글/: card.md\nreference/: ***.md, Alpha.md, zeta.md\nreference/project/: a.md, b.md\n</external_projection>"

    // when
    const disabled = renderExternalProjection(paths, {
      times: at({ "reference/zeta.md": 9, "notes/n.md": 1 }),
      limits: { maxEntriesPerDirectory: 0, maxBytes: 0 },
    })

    // then
    expect(disabled).toBe(unbounded)
    expect(renderExternalProjection(paths)).toBe(unbounded)
  })

  it("#given a byte budget below the full render #when rendered #then the largest directory shrinks first and every directory line stays", () => {
    // given
    const big = Array.from({ length: 8 }, (_, index) => `big/entry-${index}.md`)
    const paths = [...big, "small/s1.md", "small/s2.md"]
    const times = at(Object.fromEntries(paths.map((path, index) => [path, index])))
    const full = renderExternalProjection(paths, { times, limits: { maxEntriesPerDirectory: 0, maxBytes: 0 } })
    const limits = { maxEntriesPerDirectory: 0, maxBytes: bytes(full) - 40 }

    // when
    const first = renderExternalProjection(paths, { times, limits })
    const second = renderExternalProjection(paths, { times, limits })

    // then
    expect(bytes(first)).toBeLessThanOrEqual(limits.maxBytes)
    expect(first).toBe(second)
    expect(first.split("\n")).toContain("small/: s2.md, s1.md")
    expect(first).toMatch(/^big\/: (?:entry-\d\.md, )*entry-\d\.md \(\+\d+ more; read \$MEMORY_DIR\/big\/ to list\)$/m)
  })

  it("#given a budget below the floor #when rendered #then the floor render is returned and the overflow is reported", () => {
    // given
    const paths = ["ARCHIVE.md", "a/x.md", "a/y.md", "b/z.md"]
    const input = { times: at({}), limits: { maxEntriesPerDirectory: 0, maxBytes: 1 } }

    // when
    const text = renderExternalProjection(paths, input)
    const stats = renderExternalProjectionStats(paths, input)

    // then
    expect(text).toBe([
      "<external_projection>",
      "$MEMORY_DIR/: (+1 more; read $MEMORY_DIR/ to list)",
      "a/: (+2 more; read $MEMORY_DIR/a/ to list)",
      "b/: (+1 more; read $MEMORY_DIR/b/ to list)",
      "</external_projection>",
    ].join("\n"))
    expect(stats).toEqual({ shown: 0, omitted: 4, bytes: bytes(text), maxBytes: 1, overflow: true })
  })

  it("#given equal commit times #when ordered #then names break the tie, and names without a time come last", () => {
    // given
    const paths = ["d/b.md", "d/a.md", "d/untimed.md", "d/new.md"]
    const times = at({ "d/b.md": 5, "d/a.md": 5, "d/new.md": 9 })

    // when
    const text = renderExternalProjection(paths, { times, limits: { maxEntriesPerDirectory: 10, maxBytes: 0 } })

    // then
    expect(text.split("\n")).toContain("d/: new.md, a.md, b.md, untimed.md")
  })

  it("#given a render within both limits #when counted #then nothing is omitted and the bytes are exact", () => {
    // given
    const paths = ["d/a.md", "d/b.md"]
    const input = { times: at({ "d/a.md": 1, "d/b.md": 2 }), limits: { maxEntriesPerDirectory: 40, maxBytes: 24_576 } }

    // when
    const stats = renderExternalProjectionStats(paths, input)

    // then
    expect(stats).toEqual({
      shown: 2, omitted: 0, bytes: bytes(renderExternalProjection(paths, input)), maxBytes: 24_576, overflow: false,
    })
  })
})
