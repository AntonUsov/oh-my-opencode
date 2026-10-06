// Last commit time per path at a revision, kept incremental across revisions and processes.
//
// A full `git log --name-only` over a long-lived memory repo costs seconds (12k commits measured ~9 s),
// and the compiled block needs these times at every new HEAD of every session. Memory history only
// grows, so the next revision is almost always a descendant of one already computed: only the commits
// in between are read. The newest computed answer is kept in the common git dir for the next process.

import { isAbsolute, join } from "node:path"
import { readFile, rename, writeFile } from "../fs/resilient"
import type { GitRevisionRunner } from "./repo-revision-reads"

const CACHE_SIZE = 4
const FULL_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const COMMIT_MARK = "\x01"
const STORE_NAME = "omo-path-commit-times.json"

type Times = ReadonlyMap<string, number>

export class PathCommitTimes {
  private readonly computed = new Map<string, Promise<Times>>()

  constructor(
    private readonly dir: string,
    private readonly git: GitRevisionRunner,
    private readonly lsTree: (revision: string) => Promise<readonly string[]>,
  ) {}

  /**
   * Epoch-second time of the newest commit touching each path present at `revision`. Renames are not
   * followed: the compiled tree is what is listed. The answer depends only on the revision, so a full
   * object id is kept (four revisions, least recently used); a symbolic revision is resolved first.
   */
  async at(revision: string): Promise<Times> {
    const oid = FULL_OBJECT_ID.test(revision) ? revision : await this.resolve(revision)
    const cached = this.computed.get(oid)
    if (cached !== undefined) {
      this.computed.delete(oid)
      this.computed.set(oid, cached)
      return cached
    }
    const bases = [...this.computed.entries()].reverse()
    const pending = this.compute(oid, bases)
    this.computed.set(oid, pending)
    pending.catch(() => {
      if (this.computed.get(oid) === pending) this.computed.delete(oid)
    })
    const oldest = this.computed.keys().next().value
    if (this.computed.size > CACHE_SIZE && oldest !== undefined) this.computed.delete(oldest)
    return pending
  }

  private async resolve(revision: string): Promise<string> {
    return (await this.git.run(["rev-parse", "--verify", `${revision}^{commit}`])).stdout.trim()
  }

  private async compute(oid: string, bases: ReadonlyArray<readonly [string, Promise<Times>]>): Promise<Times> {
    const present = await this.lsTree(oid)
    const stored = await this.readStore()
    const candidates: Array<readonly [string, () => Promise<Times | null>]> = [
      ...bases.map(([base, times]) => [base, () => times.catch(() => null)] as const),
      ...(stored === null ? [] : [[stored.revision, async () => stored.times] as const]),
    ]
    for (const [base, load] of candidates) {
      if (base === oid) {
        const times = await load()
        if (times !== null) return liveTimes(present, times, new Map())
      }
      if (!(await this.isAncestor(base, oid))) continue
      const times = await load()
      if (times === null) continue
      const result = liveTimes(present, times, parseLogTimes((await this.log([`${base}..${oid}`])).stdout))
      if (base === stored?.revision) await this.writeStore(oid, result)
      return result
    }
    const result = liveTimes(present, new Map(), parseLogTimes((await this.log([oid])).stdout))
    if (stored === null || (await this.isAncestor(stored.revision, oid))) await this.writeStore(oid, result)
    return result
  }

  private log(range: readonly string[]): ReturnType<GitRevisionRunner["run"]> {
    return this.git.run(["log", "--format=%x01%ct", "--name-only", "-z", "--no-renames", "--diff-filter=d", ...range, "--"])
  }

  private async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    return (await this.git.result(["merge-base", "--is-ancestor", ancestor, descendant])).code === 0
  }

  private async storePath(): Promise<string> {
    const common = (await this.git.run(["rev-parse", "--git-common-dir"])).stdout.trim()
    return join(isAbsolute(common) ? common : join(this.dir, common), STORE_NAME)
  }

  /** A missing, unreadable or malformed store is treated as absent: it is a cache, never a source of truth. */
  private async readStore(): Promise<{ readonly revision: string; readonly times: Times } | null> {
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(await this.storePath(), "utf8"))
    } catch {
      return null
    }
    if (typeof parsed !== "object" || parsed === null) return null
    const { version, revision, times } = parsed as { version?: unknown; revision?: unknown; times?: unknown }
    if (version !== 1 || typeof revision !== "string" || !FULL_OBJECT_ID.test(revision)) return null
    if (typeof times !== "object" || times === null) return null
    const entries = Object.entries(times).filter((entry): entry is [string, number] => Number.isSafeInteger(entry[1]))
    return { revision, times: new Map(entries) }
  }

  private async writeStore(revision: string, times: Times): Promise<void> {
    const path = await this.storePath()
    const temp = `${path}.${process.pid}.tmp`
    await writeFile(temp, `${JSON.stringify({ version: 1, revision, times: Object.fromEntries(times) })}\n`, "utf8")
    await rename(temp, path)
  }
}

/** Newest commit time per path in a log range; the max keeps merges with skewed dates exact. */
function parseLogTimes(stdout: string): Map<string, number> {
  const times = new Map<string, number>()
  let committedAt = Number.NaN
  for (const token of stdout.split("\0")) {
    if (token.startsWith(COMMIT_MARK)) {
      committedAt = Number.parseInt(token.slice(1), 10)
      continue
    }
    const path = token.replace(/^\n/, "")
    if (path.length === 0 || !Number.isSafeInteger(committedAt)) continue
    times.set(path, Math.max(times.get(path) ?? committedAt, committedAt))
  }
  return times
}

function liveTimes(present: readonly string[], base: Times, added: Times): Times {
  const times = new Map<string, number>()
  for (const path of present) {
    const newest = Math.max(base.get(path) ?? Number.NEGATIVE_INFINITY, added.get(path) ?? Number.NEGATIVE_INFINITY)
    if (Number.isFinite(newest)) times.set(path, newest)
  }
  return times
}
