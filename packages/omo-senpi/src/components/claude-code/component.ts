import type { ComponentContext, OmoSenpiComponent, SenpiExtensionAPI } from "../../extension/types"
import { acquireClaudeCode, ClaudeCodeAcquireError, claudeCodeRegistry, type ClaudeCodeDownloadProgress } from "./acquire"
import { CLAUDE_CODE_EXECUTABLE_ENV, locateClaudeCode } from "./locate"
import { type ClaudeCodePin, readClaudeCodePin } from "./pin"

export const CLAUDE_CODE_PROVIDER = "anthropic-subscription"
export const CLAUDE_CODE_STATUS_KEY = "omo-claude-code"

type EventUi = {
  notify(message: string, level: "info" | "warning" | "error"): void
  setStatus(key: string, text: string | undefined): void
}

export type ClaudeCodeComponentOptions = {
  readonly env?: NodeJS.ProcessEnv
  readonly acquire?: typeof acquireClaudeCode
  readonly writeStderr?: (text: string) => void
}

function modelProvider(eventCtx: unknown): string | undefined {
  if (typeof eventCtx !== "object" || eventCtx === null) return undefined
  const model: unknown = Reflect.get(eventCtx, "model")
  if (typeof model !== "object" || model === null) return undefined
  const provider: unknown = Reflect.get(model, "provider")
  return typeof provider === "string" ? provider : undefined
}

function eventUi(eventCtx: unknown, writeStderr: (text: string) => void): EventUi {
  const ui: unknown = typeof eventCtx === "object" && eventCtx !== null ? Reflect.get(eventCtx, "ui") : undefined
  const hasUi = typeof eventCtx === "object" && eventCtx !== null && Reflect.get(eventCtx, "hasUI") === true
  if (hasUi && typeof ui === "object" && ui !== null) {
    return {
      notify: (message, level) => Reflect.apply(Reflect.get(ui, "notify"), ui, [message, level]),
      setStatus: (key, text) => Reflect.apply(Reflect.get(ui, "setStatus"), ui, [key, text]),
    }
  }
  return { notify: (message) => writeStderr(`${message}\n`), setStatus: () => undefined }
}

const megabytes = (bytes: number): string => `${Math.round(bytes / 1_048_576)} MB`

export function claudeCodeProgressText(pin: ClaudeCodePin, progress: ClaudeCodeDownloadProgress): string {
  const { receivedBytes, totalBytes } = progress
  const amount = totalBytes === undefined ? megabytes(receivedBytes) : `${Math.floor((receivedBytes / totalBytes) * 100)}% of ${megabytes(totalBytes)}`
  return `Downloading Claude Code ${pin.version}: ${amount}`
}

export function claudeCodeFailureNotice(pin: ClaudeCodePin, env: NodeJS.ProcessEnv, error: ClaudeCodeAcquireError): string {
  const reason = error.failure === "unreachable"
    ? `could not reach ${claudeCodeRegistry(env)} (${error.message}); check the network connection`
    : error.failure === "integrity"
      ? `the download failed its integrity check (${error.message}) and was discarded`
      : `${error.message} from ${error.url}`
  return `Claude Code ${pin.name}@${pin.version} is not installed: ${reason}. The standalone omo binary downloads Claude Code on the first Claude turn; retry once online, install Claude Code so \`claude\` is on PATH, or set ${CLAUDE_CODE_EXECUTABLE_ENV}.`
}

/**
 * The compiled omo binary cannot embed Claude Code (over the binary size budget), so the first turn on a
 * Claude subscription model downloads the pinned platform package instead. The `input` event is the only
 * extension hook senpi awaits before a prompt's auth check and provider stream (agent-session prompt()),
 * which is why the download happens here and hands the result to senpi through CLAUDE_CODE_EXECUTABLE.
 */
export function createClaudeCodeComponent(options: ClaudeCodeComponentOptions = {}): OmoSenpiComponent {
  const env = options.env ?? process.env
  const acquire = options.acquire ?? acquireClaudeCode
  const writeStderr = options.writeStderr ?? ((text: string) => void process.stderr.write(text))
  let inFlight: Promise<string> | undefined

  return {
    name: "claude-code",
    register(pi: SenpiExtensionAPI, ctx: ComponentContext): void {
      const packageDir = env.OMO_PACKAGE_DIR
      const pin = readClaudeCodePin(packageDir)
      if (pin === undefined || packageDir === undefined) return

      pi.on("input", async (_payload, eventCtx) => {
        if (modelProvider(eventCtx) !== CLAUDE_CODE_PROVIDER) return undefined
        const located = locateClaudeCode({ packageDir, pin, env })
        if (located.kind === "cached") env[CLAUDE_CODE_EXECUTABLE_ENV] = located.path
        if (located.kind !== "absent") return undefined

        const ui = eventUi(eventCtx, writeStderr)
        if (inFlight === undefined) {
          ui.notify(`Downloading Claude Code ${pin.name}@${pin.version} for the first Claude turn of this omo version; it is verified against its pinned sha512 and cached for later sessions.`, "info")
          let shownPercent = -1
          inFlight = acquire({
            packageDir,
            pin,
            env,
            onProgress: (progress) => {
              const percent = progress.totalBytes === undefined ? -1 : Math.floor((progress.receivedBytes / progress.totalBytes) * 10)
              if (percent === shownPercent) return
              shownPercent = percent
              ui.setStatus(CLAUDE_CODE_STATUS_KEY, claudeCodeProgressText(pin, progress))
            },
          })
        }
        try {
          const path = await inFlight
          env[CLAUDE_CODE_EXECUTABLE_ENV] = path
          ui.notify(`Claude Code ${pin.version} is ready: ${path}`, "info")
        } catch (error) {
          if (!(error instanceof ClaudeCodeAcquireError)) throw error
          ctx.logger.warn("omo-senpi claude-code download failed", { failure: error.failure, url: error.url, error: error.message })
          ui.notify(claudeCodeFailureNotice(pin, env, error), "error")
        } finally {
          inFlight = undefined
          ui.setStatus(CLAUDE_CODE_STATUS_KEY, undefined)
        }
        return undefined
      })
    },
  }
}
