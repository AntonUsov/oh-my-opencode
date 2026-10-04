/**
 * The plan's todo 23 bounds, judged from a gateway cost report. A row is PASS or FAIL on what was
 * measured; a row with fewer accepted samples than its target says PARTIAL-PASS / PARTIAL-FAIL, and
 * a section that never ran is NOT_RUN. The loop scan is UNPROVEN when its positive control did not
 * find the line or no host `stderr.log` was scanned.
 */
export const BOUNDS = { startup_p95_delta_ms: 20, idle_memory_delta_mb: 3, thread_list_12_p95_ms: 1500, thread_send_p95_ms: 300 }

function judge(ok, complete) {
  if (ok === undefined) return "NOT_RUN"
  return `${complete ? "" : "PARTIAL-"}${ok ? "PASS" : "FAIL"}`
}

const finite = (value) => (Number.isFinite(value) ? value : undefined)

export function verdicts(report) {
  const ab = report.sections?.ab
  const gateway = report.sections?.gateway
  const rows = {}
  const echo = ab?.startup_first_echo_delta_ms
  const startup = finite(echo?.p95)
  rows.startup = {
    bound: `p95 startup delta < ${BOUNDS.startup_p95_delta_ms} ms (spawn to the echo of a keystroke typed at the prompt; spawn to prompt beside it)`,
    measured: ab === undefined ? null : { p95_delta_ms: startup ?? null, min_of_n_delta_ms: echo?.min ?? null, p50_delta_ms: echo?.p50 ?? null, p95_a: ab.startup_first_echo_ms?.a?.p95 ?? null, p95_b: ab.startup_first_echo_ms?.b?.p95 ?? null, min_a: ab.startup_first_echo_ms?.a?.min ?? null, min_b: ab.startup_first_echo_ms?.b?.min ?? null, prompt_p95_delta_ms: ab.startup_delta_ms?.p95 ?? null, prompt_min_delta_ms: ab.startup_delta_ms?.min ?? null },
    n: ab?.accepted_pairs ?? 0,
    verdict: judge(startup === undefined ? undefined : startup < BOUNDS.startup_p95_delta_ms, ab?.partial === false),
  }
  const footprint = finite(ab?.idle_footprint_delta_mb?.p50)
  rows.idle_memory = {
    bound: `idle RSS delta < ${BOUNDS.idle_memory_delta_mb} MB (judged on the median whole-tree physical footprint delta; RSS beside it)`,
    measured: ab === undefined ? null : { footprint_p50_delta_mb: footprint ?? null, footprint_min_delta_mb: ab.idle_footprint_delta_mb?.min ?? null, rss_p50_delta_mb: ab.idle_rss_delta_mb?.p50 ?? null, rss_min_delta_mb: ab.idle_rss_delta_mb?.min ?? null, footprint_paired_p50_mb: ab.idle_footprint_delta_mb?.paired?.p50 ?? null },
    n: ab?.accepted_pairs ?? 0,
    verdict: judge(footprint === undefined ? undefined : footprint < BOUNDS.idle_memory_delta_mb, ab?.partial === false),
  }
  const n12 = gateway?.thread_list?.n12
  const listP95 = n12?.cold?.n > 0 || n12?.warm?.n > 0 ? Math.max(n12.cold?.p95 ?? 0, n12.warm?.p95 ?? 0) : undefined
  const listClean = n12 !== undefined && (n12.cold?.timeouts ?? 0) + (n12.warm?.timeouts ?? 0) === 0 && [...(n12.cold?.tui_rows_listed ?? []), ...(n12.warm?.tui_rows_listed ?? [])].every((rows) => rows === 12)
  rows.thread_list_12 = {
    bound: `thread_list with 12 endpoints < ${BOUNDS.thread_list_12_p95_ms} ms p95 (cold and warm series, tool boundary)`,
    measured: n12 === undefined ? null : { cold_p95_ms: n12.cold?.p95 ?? null, cold_min_ms: n12.cold?.min ?? null, warm_p95_ms: n12.warm?.p95 ?? null, warm_min_ms: n12.warm?.min ?? null, cold_roundtrip_p95_ms: n12.cold?.roundtrip_ms?.p95 ?? null, every_call_listed_12: listClean },
    n: (n12?.cold?.n ?? 0) + (n12?.warm?.n ?? 0),
    verdict: judge(listP95 === undefined ? undefined : listP95 < BOUNDS.thread_list_12_p95_ms && listClean, n12?.partial === false),
  }
  const send = gateway?.thread_send
  const sendP95 = finite(send?.tool?.p95)
  rows.thread_send = {
    bound: `thread_send to an idle endpoint < ${BOUNDS.thread_send_p95_ms} ms p95 (tool entry to tool return)`,
    measured: send === undefined ? null : { p95_ms: sendP95 ?? null, min_ms: send.tool?.min ?? null, cold_p95_ms: send.tool_cold?.p95 ?? null, warm_p95_ms: send.tool_warm?.p95 ?? null, acceptance_p95_ms: send.acceptance?.p95 ?? null, provider_roundtrip_p95_ms: send.provider_roundtrip?.p95 ?? null, not_ok: send.not_ok },
    n: send?.tool?.n ?? 0,
    verdict: judge(sendP95 === undefined ? undefined : sendP95 < BOUNDS.thread_send_p95_ms && send.not_ok === 0, send?.partial === false),
  }
  const loop = report.event_loop_blocked
  const proven = loop?.control?.found === true && (loop?.host_stderr_files ?? 0) > 0
  rows.event_loop_blocked = {
    bound: "zero `event loop blocked` lines (every pty stream, every sandbox agent dir, every host stderr.log)",
    measured: { lines: loop?.hits?.length ?? null, files_scanned: loop?.files_scanned ?? null, streams_scanned: loop?.streams_scanned ?? null, host_stderr_files: loop?.host_stderr_files ?? null, control_found: loop?.control?.found ?? null },
    verdict: (loop?.hits?.length ?? 0) > 0 ? "FAIL" : proven ? "PASS" : "UNPROVEN",
  }
  return rows
}
