import { describe, expect, test } from "bun:test"
import { compactionPrompt, contextStub, splitSummary } from "../src/format"

describe("splitSummary", () => {
  test("splits essential and detail blocks", () => {
    const out = splitSummary("<essential>\n## Objective\n- a\n</essential>\n\n<detail>\nlong\n</detail>")
    expect(out).toEqual({ essential: "## Objective\n- a", detail: "long" })
  })

  test("tolerates a missing closing tag on essential", () => {
    expect(splitSummary("<essential>short\n<detail>long</detail>")).toEqual({ essential: "short", detail: "long" })
  })

  test("tolerates a truncated detail block", () => {
    expect(splitSummary("<essential>e</essential><detail>cut off").detail).toBe("cut off")
  })

  test("keeps the whole text as essential when the format is ignored", () => {
    expect(splitSummary("  plain summary  ")).toEqual({ essential: "plain summary", detail: "" })
  })
})

describe("compactionPrompt", () => {
  test("first compaction has no prior block", () => {
    const p = compactionPrompt({ essentialTokens: 1500, detailTokens: 6000 })
    expect(p).toContain("<essential>")
    expect(p).toContain("about 6000 tokens")
    expect(p).not.toContain("<prior-essential>")
  })

  test("later compactions carry the prior essential and archived files", () => {
    const p = compactionPrompt({
      essentialTokens: 800,
      detailTokens: 3000,
      prior: { essential: "PRIOR STATE", files: ["/a/001.md", "/a/002.md"] },
    })
    expect(p).toContain("under about 800 tokens")
    expect(p).toContain("<prior-essential>\nPRIOR STATE\n</prior-essential>")
    expect(p).toContain("- /a/001.md\n- /a/002.md")
  })
})

test("contextStub lists the essential and the archive", () => {
  const e1 = { n: 1, messageID: "m1", file: "/x/001.md", essential: "old", created: "" }
  const e2 = { n: 2, messageID: "m2", file: "/x/002.md", essential: "NOW", created: "" }
  const stub = contextStub(e2, [e1, e2])
  expect(stub).toStartWith("[Session memory: compacted 2 times]")
  expect(stub).toContain("NOW")
  expect(stub).not.toContain("old")
  expect(stub).toContain("- /x/001.md (segment 1)\n- /x/002.md (segment 2)")
})
