/**
 * (a) startup and (b) idle memory of an interactive TUI, engine commit A/B (plan todo 23).
 *
 * The same omo launcher and plugin (this checkout) run on two senpi source builds: `--engine-a` and
 * `--engine-b`. Nothing else differs; no seam or flag switches the listener off. Each side keeps ONE
 * isolated agent dir (a user restarting a terminal): one discarded warm-up per side pays the first
 * launch, then pairs run interleaved, alternating A,B / B,A. A pair is one load batch: a pair whose
 * load jumped is discarded and re-taken. Startup = spawn to the editor prompt on screen; on an engine
 * with the endpoint the registry record is timed too. Time to interactive = spawn to the echo of a
 * keystroke typed at the prompt (the startup bound is judged on it). Idle memory = the TUI's whole process tree
 * (RSS and physical footprint), `idleMs` after it is fully up.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs"
import { join, resolve } from "node:path"

import { createBatches, delta, load1, stats } from "./task-host-e2e-gateway-cost-batch.mjs"
import { alive, commandOf, scanText, scanTree, sweepMarker, treeMemory } from "./task-host-e2e-gateway-cost-scan.mjs"

const gw = await import("./thread-tools/lib/gateway.mjs")
const { bus, waitFor, makeScratch, registryEndpoints, OMO_ROOT, KIT_DIR } = gw

/** `<run>/kit-<side>/{node_modules/@code-yeongyu/senpi -> engine, omo/{bin,package.json,plugin}}`. */
function abInstall(runRoot, side, engineDir) {
  const engine = resolve(engineDir)
  for (const required of ["package.json", join("dist", "cli.js")]) if (!existsSync(join(engine, required))) throw new Error(`engine ${side} has no ${required} at ${engine}: build it first`)
  const kit = join(runRoot, `kit-${side}`)
  mkdirSync(join(kit, "node_modules", "@code-yeongyu"), { recursive: true })
  symlinkSync(engine, join(kit, "node_modules", "@code-yeongyu", "senpi"))
  const root = join(kit, "omo")
  cpSync(join(OMO_ROOT, "packages", "omo-native", "bin"), join(root, "bin"), { recursive: true })
  cpSync(join(OMO_ROOT, "packages", "omo-native", "package.json"), join(root, "package.json"))
  cpSync(join(OMO_ROOT, "packages", "omo-senpi", "plugin"), join(root, "plugin"), { recursive: true })
  return { side, engine, engineVersion: JSON.parse(readFileSync(join(engine, "package.json"), "utf8")).version, omoJs: join(root, "bin", "omo.js") }
}

let Terminal
async function newTerminal(cols, rows) {
  if (Terminal === undefined) {
    const mod = await import(join(KIT_DIR, "node_modules", "@xterm", "headless", "lib-headless", "xterm-headless.js"))
    Terminal = mod.Terminal ?? mod.default?.Terminal
  }
  return new Terminal({ cols, rows, allowProposedApi: true, scrollback: 2000 })
}

/** The editor line holds `text` (what a typed keystroke looks like once the TUI handled it). */
function editorShows(term, text) {
  const buffer = term.buffer.active
  for (let row = 0; row < term.rows; row += 1) {
    const line = buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? ""
    if (line.startsWith("❯") && line.includes(text)) return true
  }
  return false
}

function promptVisible(term) {
  const buffer = term.buffer.active
  for (let row = 0; row < term.rows; row += 1) if ((buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "").startsWith("❯")) return true
  return false
}

/** One TUI start: timings, idle memory, endpoint count, then a full teardown of its tree. */
async function abSample(ctx, install, scratch, seen, index) {
  const term = await newTerminal(120, 40)
  const raw = []
  let exitCode
  const sample = { side: install.side, index, load1_start: load1() }
  ctx.log(`ab ${install.side}${index} start`)
  const t0 = performance.now()
  const proc = Bun.spawn([process.env.THREAD_QA_NODE ?? "node", install.omoJs], {
    cwd: scratch.work,
    env: scratch.env,
    detached: true,
    terminal: { cols: 120, rows: 40, data: (_terminal, data) => {
      const text = typeof data === "string" ? data : Buffer.from(data).toString("utf8")
      raw.push(text)
      term.write(text, () => bus.emit("tick", "pty"))
    } },
  })
  void proc.exited.then((code) => {
    exitCode = code
    bus.emit("tick", "exit")
  })
  sample.pid = proc.pid
  let tree = []
  try {
    sample.prompt_ms = await waitFor(() => {
      if (exitCode !== undefined) throw new Error(`TUI ${install.side}${index} exited ${exitCode} before its prompt: ${raw.join("").slice(-600)}`)
      return promptVisible(term) ? performance.now() - t0 : undefined
    }, { label: `TUI ${install.side}${index} prompt`, timeoutMs: 90_000 })
    // Time to interactive: a keystroke typed at the prompt is echoed only once the TUI's loop is free,
    // so synchronous startup work after the first paint shows here and not in prompt_ms.
    proc.terminal.write(ECHO_PROBE)
    sample.first_echo_ms = await waitFor(() => {
      if (exitCode !== undefined) throw new Error(`TUI ${install.side}${index} exited ${exitCode} before echoing`)
      return editorShows(term, ECHO_PROBE) ? performance.now() - t0 : undefined
    }, { label: `TUI ${install.side}${index} echo`, timeoutMs: 60_000 })
    proc.terminal.write("\x15")
    if (install.expectEndpoint) {
      sample.endpoint_ms = await waitFor(() => {
        const fresh = registryEndpoints(scratch.agentDir).find((endpoint) => endpoint.endpoint_kind === "tui" && !seen.has(endpoint.socket) && existsSync(endpoint.socket))
        if (fresh === undefined) return undefined
        seen.add(fresh.socket)
        return performance.now() - t0
      }, { label: `TUI ${install.side}${index} endpoint`, timeoutMs: 60_000 })
    }
    // Idle memory is time-defined: the tree measured a fixed idle window after it is fully up.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, ctx.opts.idleMs))
    const memory = treeMemory(proc.pid)
    tree = memory.tree
    Object.assign(sample, { rss_mb: memory.rss_mb, footprint_mb: memory.footprint_mb, footprint_unmeasured: memory.footprint_unmeasured, processes: memory.processes })
    sample.tui_endpoints = registryEndpoints(scratch.agentDir).filter((endpoint) => endpoint.endpoint_kind === "tui" && existsSync(endpoint.socket)).length
    sample.load1_end = load1()
  } finally {
    try {
      process.kill(-proc.pid, "SIGTERM")
    } catch {
      // Already gone.
    }
    const exited = await Promise.race([proc.exited.then(() => true), new Promise((resolvePromise) => setTimeout(() => resolvePromise(false), 8000))])
    if (!exited) {
      try {
        process.kill(-proc.pid, "SIGKILL")
      } catch {
        // Gone.
      }
      await proc.exited
    }
    // Descendants that left the pty's group: killed only while their command still names this run.
    for (const entry of tree) if (entry.pid !== proc.pid && alive(entry.pid) && commandOf(entry.pid).includes(ctx.runRoot)) process.kill(entry.pid, "SIGKILL")
    sample.swept = sweepMarker(scratch.dir)
    scanText(ctx.scan, raw.join(""), `ab ${install.side}${index} pty`)
  }
  return sample
}

const ECHO_PROBE = "zq"
const sideStats = (samples, key) => ({ a: stats(samples.a.map((s) => s[key])), b: stats(samples.b.map((s) => s[key])) })
const deltas = (pair, paired) => ({ p95: delta(pair.b.p95, pair.a.p95), min: delta(pair.b.min, pair.a.min), p50: delta(pair.b.p50, pair.a.p50), paired })

/** Fills `out` as it goes, so a deadline or a failure still leaves every finished pair in the report. */
export async function abSection(ctx, fake, out) {
  const a = { ...abInstall(ctx.runRoot, "a", ctx.opts.engineA), expectEndpoint: false }
  const b = { ...abInstall(ctx.runRoot, "b", ctx.opts.engineB), expectEndpoint: true }
  ctx.log(`ab: A ${a.engineVersion} (${a.engine}), B ${b.engineVersion} (${b.engine}) ${ctx.opts.labelB}`)
  Object.assign(out, { control_method: "engine commit A/B (same omo launcher and plugin; no seam, no flag)", variant_b: ctx.opts.labelB, engines: { a: { path: a.engine, version: a.engineVersion }, b: { path: b.engine, version: b.engineVersion } }, idle_ms: ctx.opts.idleMs, target_pairs: ctx.opts.samples })
  const sandbox = { a: makeScratch("t23a", fake), b: makeScratch("t23b", fake) }
  const seen = { a: new Set(), b: new Set() }
  out.warmup = [await abSample(ctx, a, sandbox.a, seen.a, "w"), await abSample(ctx, b, sandbox.b, seen.b, "w")]
  const batches = createBatches("ab pair", { log: ctx.log, deadline: ctx.deadline, retakes: 2 })
  for (let index = 0; index < ctx.opts.samples; index += 1) {
    const order = index % 2 === 0 ? [a, b] : [b, a]
    const batch = await batches.run(`pair ${index}`, async () => {
      const pair = []
      for (const install of order) pair.push(await abSample(ctx, install, sandbox[install.side], seen[install.side], index))
      return pair
    })
    if (batch === undefined && ctx.deadline.reached()) break
    if (batch !== undefined) for (const s of batch.samples) ctx.log(`ab ${s.side}${index} prompt=${Math.round(s.prompt_ms)}ms echo=${Math.round(s.first_echo_ms)}ms${s.endpoint_ms === undefined ? "" : ` endpoint=${Math.round(s.endpoint_ms)}ms`} rss=${s.rss_mb}MB footprint=${s.footprint_mb}MB tui_endpoints=${s.tui_endpoints} load=${batch.after.load[0]}`)
  }
  for (const side of ["a", "b"]) {
    scanTree(ctx.scan, sandbox[side].agentDir, `ab ${side} agent dir`)
    rmSync(sandbox[side].dir, { recursive: true, force: true })
  }
  const pairs = batches.accepted.map((batch) => Object.fromEntries(batch.samples.map((s) => [s.side, s])))
  const samples = { a: pairs.map((pair) => pair.a), b: pairs.map((pair) => pair.b) }
  const paired = (key) => stats(pairs.map((pair) => pair.b[key] - pair.a[key]))
  const prompt = sideStats(samples, "prompt_ms")
  const echo = sideStats(samples, "first_echo_ms")
  const rss = sideStats(samples, "rss_mb")
  const footprint = sideStats(samples, "footprint_mb")
  Object.assign(out, {
    accepted_pairs: pairs.length,
    partial: pairs.length < ctx.opts.samples,
    batches: batches.summary(),
    samples,
    endpoint_check: { a_with_tui_endpoint: samples.a.filter((s) => s.tui_endpoints !== 0).length, b_without_exactly_one: samples.b.filter((s) => s.tui_endpoints !== 1).length },
    startup_prompt_ms: prompt,
    startup_first_echo_ms: echo,
    startup_first_echo_delta_ms: deltas(echo, paired("first_echo_ms")),
    startup_endpoint_ms_b: stats(samples.b.map((s) => s.endpoint_ms)),
    startup_delta_ms: deltas(prompt, paired("prompt_ms")),
    idle_rss_mb: rss,
    idle_rss_delta_mb: deltas(rss, paired("rss_mb")),
    idle_footprint_mb: footprint,
    idle_footprint_delta_mb: deltas(footprint, paired("footprint_mb")),
  })
  return out
}
