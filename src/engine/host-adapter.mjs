/**
 * The production adapters: the only file that knows DSH.
 *
 * Everything else in `src/engine/` is pure Node and dependency-injected, which
 * is why it can be tested without a harness. This module turns three Host
 * services into those injected interfaces:
 *
 * | adapter | Host services | what it must get right |
 * |---|---|---|
 * | child   | `ctx.subprocess` | Electron needs `ELECTRON_RUN_AS_NODE`, and stdio must be pipes |
 * | agent   | `ctx.agents`, `ctx.subagents`, session events | persistent session, persona as a system section, structured capture |
 * | exec    | `ctx.sandbox` + `ctx.sandboxPolicy` + `ctx.subprocess` | confine BEFORE spawn; never a shell |
 *
 * Three deliberate deviations from the original plan, each because the API it
 * assumed could not be verified in this build:
 *
 * 1. **No `tools.register(..., { when })`.** The conditional-registration option
 *    is not part of any contract this session could confirm, so the
 *    `structured_output` tool is registered once per child and validates against
 *    the *current* turn's schema when it is called. A stale capture is rejected
 *    there and the actor pool's repair loop handles it.
 * 2. **`followup` is preferred for a turn.** `subagents.sendMessage` gates on
 *    durable continuation state ("cannot be resumed"), which a child created
 *    through `agents.create` does not carry, so the live inbox is the correct
 *    door: `agent.followup(message)` then `await agent.whenIdle()`. `sendMessage`
 *    stays as a fallback for a composition that exposes no `followup`.
 * 3. **Replies are read from the session log**, not from a return value: a
 *    `whenIdle()` agent has no "result", only a transcript.
 *
 * @module dsh-workflow-zcode/engine/host-adapter
 */

import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { validate } from './actor-pool.mjs'
import { createDecoder, encode } from './protocol.mjs'

/** Absolute path of the sandbox entry, resolved from this module. */
export const CHILD_ENTRY = fileURLToPath(new URL('./child-entry.mjs', import.meta.url))

/** Pull the visible text out of one assistant message. */
export function messageText(message) {
  if (message === null || typeof message !== 'object') return ''
  const blocks = Array.isArray(message.content)
    ? message.content
    : (Array.isArray(message.blocks) ? message.blocks : [])
  const parts = []
  for (const block of blocks) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n')
}

/**
 * The model options a workflow subagent inherits from the agent that ran it.
 *
 * A child created without `provider`/`model` fails its first pre-step with
 * "has no provider/model". The parent's most recent committed request is the
 * authority (it reflects a model switch mid-session), with the parent's own
 * options as the fallback.
 *
 * @param {object} parentAgent
 * @param {{ provider?: string, model?: string }} [defaults]
 * @returns {{ provider?: string, model?: string, reasoningEffort?: unknown, maxTokens?: number, subagentDepth: number }}
 */
export function resolveChildAgentOptions(parentAgent, defaults = {}) {
  let config
  try {
    config = parentAgent?.session?.requestHeader?.()?.config
  } catch {
    config = undefined
  }
  const parentOptions = parentAgent?.options ?? {}
  const provider = config?.provider ?? parentOptions.provider ?? defaults.provider
  const model = config?.model ?? parentOptions.model ?? defaults.model
  const reasoningEffort = config?.reasoningEffort ?? parentOptions.reasoningEffort
  const maxTokens = parentOptions.maxTokens ?? config?.maxTokens
  return {
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    subagentDepth: (parentOptions.subagentDepth ?? 0) + 1,
  }
}

/**
 * Spawn `child-entry.mjs` and expose the protocol the run service expects.
 *
 * @param {object} input
 * @param {{ spawn: Function }} input.subprocess
 * @param {string} input.cwd
 * @param {AbortSignal} [input.signal]
 * @param {string} [input.execPath] defaults to the current Node binary
 * @returns {{ send: Function, onMessage: Function, waitForExit: Function, terminate: Function }}
 */
export function createChildProcess({ subprocess, cwd, signal, execPath = process.execPath }) {
  const handle = subprocess.spawn({
    argv: [execPath, CHILD_ENTRY],
    cwd,
    stdio: {
      stdin: 'pipe',
      // PIPE, not collect: this is a live protocol, so the raw stream is what we
      // need. Collect mode buffers for a reader that may never be polled, which
      // is how an earlier version sat silent with a healthy child process.
      stdout: 'pipe',
      stderr: { maxBytes: 256 * 1024, spill: { maxBytes: 1024 * 1024 } },
    },
    graceMs: 5_000,
    // The desktop Host is Electron: without this the binary starts a GUI thread
    // instead of running `CHILD_ENTRY` as a script.
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    ...(signal === undefined ? {} : { signal }),
  })

  const handlers = []
  const feed = createDecoder((message) => {
    for (const handler of handlers) handler(message)
  })

  let stdinBroken = false
  let exited = false
  if (typeof handle.done?.then === 'function') {
    void handle.done.then(() => { exited = true }, () => { exited = true })
  }
  if (typeof handle.stdin?.on === 'function') {
    // A child can exit or crash while the host still has an in-flight reply;
    // handling stream errors keeps async write EPIPE from killing the host.
    handle.stdin.on('error', () => { stdinBroken = true })
    handle.stdin.on('close', () => { stdinBroken = true })
  }

  if (handle.stdout !== undefined) {
    handle.stdout.on('error', () => {})
    handle.stdout.on('data', (chunk) => feed(chunk))
    if (typeof handle.stdout.setEncoding === 'function') handle.stdout.setEncoding('utf8')
  } else if (handle.collected?.stdout !== undefined) {
    // Fallback for a provider that only exposes the offset reader.
    let offset = 0
    const pump = () => {
      const read = handle.collected.stdout.readFrom(offset)
      if (read.text === '') return
      offset = read.nextOffset
      feed(read.text)
    }
    const timer = setInterval(pump, 20)
    void handle.done.finally(() => {
      clearInterval(timer)
      pump()
    })
  }

  return {
    send(message) {
      const stream = handle.stdin
      if (stream === undefined) throw new Error('the workflow child has no stdin')
      if (
        exited ||
        stdinBroken ||
        stream.destroyed === true ||
        stream.writableEnded === true ||
        stream.writableFinished === true ||
        stream.writable === false
      ) {
        return false
      }
      try {
        return stream.write(encode(message))
      } catch {
        stdinBroken = true
        return false
      }
    },
    onMessage(handler) {
      handlers.push(handler)
    },
    async waitForExit() {
      const outcome = await handle.done
      return outcome.exitCode
    },
    terminate() {
      try {
        handle.terminate()
      } catch {
        // already gone
      }
    },
  }
}

/**
 * Tokens reported for one assistant message.
 *
 * `totalTokens` wins when the Host provides it; otherwise sum the four buckets
 * the protocol exposes. A missing/zero usage is normal (some providers omit it)
 * and must not invent a number.
 */
export function usageOfAssistantEvent(event) {
  return usageTokensOf({ usage: event?.data?.usage ?? event?.data?.message?.usage })
}

export function usageTokensOf(message) {
  const usage = message?.usage
  if (usage === null || typeof usage !== 'object') return 0
  const total = Number(usage.totalTokens)
  if (Number.isFinite(total) && total > 0) return total
  const sum = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']
    .map((key) => Number(usage[key]) || 0)
    .reduce((left, right) => left + right, 0)
  return Number.isFinite(sum) && sum > 0 ? sum : 0
}

/** Build the complete JSON Schema root `tools.register()` expects. */
function parametersSchema(properties, required = []) {
  return {
    type: 'object',
    properties,
    ...(required.length === 0 ? {} : { required }),
  }
}

/**
 * Drive persistent child agents through the Host's Agent service.
 *
 * @param {object} input
 * @param {object} input.ctx the plugin context (for `on` and `get`)
 * @param {object} input.agents `ctx.agents`
 * @param {object} input.subagents `ctx.subagents`
 * @param {object} input.parentAgent the agent that called the tool
 * @param {string} input.cwd
 * @param {object} [input.agentOptions] provider/model pins for children
 * @returns {{ createActor: Function, sendTurn: Function, readReply: Function, dispose: Function }}
 */
export function createAgentRuntime({ ctx, agents, subagents, parentAgent, cwd, agentOptions, signal, usageSink }) {
  /** childSessionId → { lastText, captured, schema, persona, turnError, tokens } */
  const sessions = new Map()
  const entryFor = (sessionId) => {
    let entry = sessions.get(sessionId)
    if (entry === undefined) {
      entry = {
        lastText: '', captured: undefined, schema: undefined, persona: undefined,
        turnError: undefined, tokens: 0,
      }
      sessions.set(sessionId, entry)
    }
    return entry
  }

  /**
   * The `structured_output` tool for one child session.
   *
   * Registered once per child; it validates against the schema of the CURRENT
   * turn, so a capture can never satisfy a later ask with a different shape.
   */
  const structuredOutputTool = (sessionId, toolName = 'structured_output') => ({
      name: toolName,
      description:
        'Submit the structured result for the current workflow step. '
        + 'Call this with a JSON object that satisfies the schema in the task. '
        + 'It is the only accepted way to return a typed result.'
        + (toolName === 'submit_result' ? ' (ZCode-compatible alias of structured_output.)' : ''),
      parameters: parametersSchema({
        json: {
          type: 'string',
          description: 'The JSON object, serialised, satisfying the schema given in the task.',
        },
      }, ['json']),
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: () => [{ type: 'text', text: 'structured result accepted' }],
      },
      execute(args, exec) {
        const current = sessions.get(sessionId)
        if (current?.schema === undefined) {
          return { error: { message: 'this step does not expect a structured result' } }
        }
        // Accept the documented `{ json: "<serialised>" }`, a direct object
        // (some models pass the parsed value), or a JSON string in `json`.
        let parsed
        const raw = args?.json
        if (typeof raw === 'string') {
          try {
            parsed = JSON.parse(raw)
          } catch {
            return { error: { message: 'json must be a serialised JSON object' } }
          }
        } else if (raw !== null && typeof raw === 'object') {
          parsed = raw
        } else {
          return { error: { message: 'json must be a serialised JSON object' } }
        }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return { error: { message: 'json must be a JSON object' } }
        }
        // Validate HERE so a wrong shape comes back as a tool error the
        // model can correct in the same turn, instead of a failed ask.
        const violations = validate(parsed, current.schema)
        if (violations.length > 0) {
          return { error: { message: `does not match the schema: ${violations.join('; ')}` } }
        }
        current.captured = parsed
        // A host that can close the turn early should, so the child stops
        // producing prose after a valid submission.
        if (typeof exec?.concludeTurn === 'function') {
          try {
            exec.concludeTurn()
          } catch {
            // concluding is an optimisation, not a requirement
          }
        }
        return { accepted: true }
      },
    });

  /** Normalise one tool descriptor from any of the Host's enumeration APIs. */
  const normaliseTool = (entry) => {
    const fn = entry?.function ?? entry?.tool ?? entry
    const name = fn?.name ?? entry?.name ?? entry?.id
    if (typeof name !== 'string' || name === '') return undefined
    return { name, description: String(fn?.description ?? entry?.description ?? '') }
  }

  /** Read the tools visible to a child, tolerating a context without enumeration. */
  const listVisibleTools = async (agentCtx, agent) => {
    const tools = agentCtx?.tools
    const attempts = [
      () => tools?.schemas?.(agent),
      () => tools?.definitions?.(),
      () => tools?.view?.(agent),
    ]
    for (const attempt of attempts) {
      try {
        const value = await attempt()
        if (Array.isArray(value)) return value.map(normaliseTool).filter((tool) => tool !== undefined)
      } catch {
        // try the next enumeration shape
      }
    }
    return []
  }

  /** `select:` prefix and comma / 顿号 / whitespace separated terms. */
  const parseToolQuery = (raw) => {
    let text = String(raw ?? '').trim()
    if (/^select\s*:/iu.test(text)) text = text.replace(/^select\s*:/iu, '')
    return text.split(/[,\u3001\s]+/u).map((term) => term.trim()).filter((term) => term !== '')
  }

  const LOCAL_TOOL_SEARCH_NOTE =
    '当前 DSH 运行时已将上述工具（含 MCP 工具）直接预加载到上下文中，无需额外加载动作，可直接调用它们。'

  const localToolSearchTool = (agentCtx, child) => ({
    name: 'LocalToolSearch',
    description:
      'Search the tools already available in this session by name or description. '
      + 'The matches are immediately callable; this tool only lists them.',
    parameters: parametersSchema({
      query: {
        type: 'string',
        description: 'Keywords to match against tool names/descriptions. Supports "select:" prefixes and comma/顿号 separated terms.',
      },
      max_results: { type: 'number', description: 'Maximum matches to return (default 10, max 50).' },
    }),
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        const matches = Array.isArray(value?.matches) ? value.matches : []
        const lines = matches.length === 0
          ? ['LocalToolSearch: no matching tool.']
          : [`LocalToolSearch: ${matches.length} match(es) of ${value?.total ?? matches.length} visible tool(s).`]
        for (const match of matches) {
          lines.push(`- ${match.name}${match.description === '' ? '' : ` — ${match.description}`}`)
        }
        lines.push(LOCAL_TOOL_SEARCH_NOTE)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const query = typeof args?.query === 'string' ? args.query : ''
      const requested = Number(args?.max_results)
      const max = Number.isFinite(requested) ? Math.max(1, Math.min(50, Math.floor(requested))) : 10
      const visible = await listVisibleTools(agentCtx, exec?.agent ?? child)
      const terms = parseToolQuery(query).map((term) => term.toLowerCase())
      const matches = terms.length === 0
        ? visible
        : visible.filter((tool) => terms.some((term) => (
          tool.name.toLowerCase().includes(term) || tool.description.toLowerCase().includes(term)
        )))
      return {
        query,
        matches: matches.slice(0, max),
        total: visible.length,
        note: LOCAL_TOOL_SEARCH_NOTE,
        // An empty enumeration is not an error: the caller still gets the note.
        ...(visible.length === 0 ? { enumeration: 'unavailable' } : {}),
      }
    },
  })

  /**
   * Everything a child session needs, registered in ONE place so `createActor`
   * and `resumeActor` can never drift apart.
   */
  const registerChildTools = (agentCtx, child, sessionId) => {
    // `structured_output` is this plugin's name; `submit_result` is ZCode's.
    // Both write the same capture slot, so either satisfies the current ask.
    for (const toolName of ['structured_output', 'submit_result']) {
      agentCtx.tools.register(structuredOutputTool(sessionId, toolName))
    }
    // Do not fight a future native LocalToolSearch: register only when absent.
    let existing
    try {
      existing = typeof agentCtx.tools?.get === 'function'
        ? agentCtx.tools.get('LocalToolSearch', child)
        : undefined
    } catch {
      // a context without a readable registry is treated as 'absent'
      existing = undefined
    }
    if (existing === undefined) agentCtx.tools.register(localToolSearchTool(agentCtx, child))
  }

  // One subscription for the whole run: assistant messages are the transcript,
  // and the structured capture wins over text when both are present.
  const off = ctx.on('session/event', (session, event) => {
    const entry = sessions.get(session.id)
    if (entry === undefined) return
    if (event.type === 'assistant/message') {
      const text = messageText(event.data?.message)
      if (text !== '') entry.lastText = text
      // Token usage arrives with the assistant message. Accumulate per session
      // and report the delta, so a run can settle with a real `spent_tokens`
      // instead of a hardcoded zero.
      // The Host carries provider usage beside the message (`data.usage`), not
      // inside `data.message`; reading only the message kept `spent_tokens` at 0.
      const delta = usageOfAssistantEvent(event)
      if (delta > 0) {
        entry.tokens += delta
        try {
          usageSink?.({ sessionId: session.id, tokens: delta })
        } catch {
          // a broken observer must not fail the turn
        }
      }
      return
    }
    if (event.type === 'turn/end') {
      // A failed or aborted turn produces NO assistant text. Without this, the
      // actor pool sees an empty reply and reports "did not answer with JSON",
      // which sends the reader chasing a parse problem that never existed.
      const reason = event.data?.reason
      if (reason?.kind === 'error') {
        entry.turnError = `the subagent turn failed: ${reason.error?.message ?? 'unknown model error'}`
      } else if (reason?.kind === 'aborted') {
        entry.turnError = `the subagent turn was aborted (${reason.reason?.kind ?? 'unknown'})`
      }
    }
  })

  return {
    async createActor({ sessionId, name, persona }) {
      const entry = entryFor(sessionId)
      entry.persona = persona ?? null
      const personaText = typeof persona === 'string'
        ? persona
        : (persona !== null && typeof persona === 'object' && typeof persona.system === 'string' ? persona.system : '')

      const handle = await agents.create({
        sessionId,
        meta: { cwd, parentSession: parentAgent.id, origin: 'subagent' },
        ...(agentOptions === undefined ? {} : { agentOptions }),
        async setup(agentCtx, child) {
          // Standing instructions belong to the child's context, installed once.
          // `text` is the field the prompt assembler reads; `interpolate: false`
          // keeps a persona that contains {{...}} from being treated as a template.
          if (personaText !== '') {
            agentCtx.systemPrompt.section({
              name: 'zcode-actor-persona',
              order: 20,
              text: personaText,
              interpolate: false,
            })
          }
          // The child must read the same workspace the workflow runs in.
          try {
            await agentCtx.get?.('workingDirectory')?.set?.(child, cwd, signal)
          } catch {
            // a composition without the service keeps the inherited directory
          }
          // The capture tool is registered once; it validates against whatever
          // schema the CURRENT turn published, which is how a per-ask schema is
          // enforced without the unverified `when` option.
          registerChildTools(agentCtx, child, sessionId)
        },
      })
      // `resolved_model` records `provider/model`, the shape the journal and the
      // origin's column both use; a bare model id would be ambiguous.
      const resolvedModel = agentOptions?.provider !== undefined && agentOptions?.model !== undefined
        ? `${agentOptions.provider}/${agentOptions.model}`
        : agentOptions?.model
      return { ...handle, sessionId, name: handle?.name ?? name, persona: persona ?? null, model: resolvedModel }
    },

    /**
     * Reattach to a session this plugin created in an earlier attempt.
     *
     * A fresh session would silently lose the actor's earlier turns, which is
     * worse than failing: the replay would then disagree with the recorded run.
     */
    async resumeActor({ sessionId, cwd, name, persona }) {
      const entry = entryFor(sessionId)
      entry.persona = persona ?? null
      const personaText = typeof persona === 'string'
        ? persona
        : (persona !== null && typeof persona === 'object' && typeof persona.system === 'string' ? persona.system : '')
      try {
        const handle = await agents.resume({
          resumeSessionId: sessionId,
          ...(agentOptions === undefined ? {} : { agentOptions }),
          async setup(agentCtx, child) {
            if (personaText !== '') {
              agentCtx.systemPrompt.section({
                name: 'zcode-actor-persona',
                order: 20,
                text: personaText,
                interpolate: false,
              })
            }
            try {
              await agentCtx.get?.('workingDirectory')?.set?.(child, cwd, signal)
            } catch {
              // keep the inherited directory
            }
            registerChildTools(agentCtx, child, sessionId)
          },
        })
        const resolvedModel = agentOptions?.provider !== undefined && agentOptions?.model !== undefined
          ? `${agentOptions.provider}/${agentOptions.model}`
          : agentOptions?.model
        return { ...handle, sessionId, name: handle?.name ?? name, persona: persona ?? null, model: resolvedModel }
      } catch (error) {
        const failure = new Error(
          `the actor session ${sessionId} could not be resumed: ${error instanceof Error ? error.message : String(error)}`,
        )
        failure.code = 'actor_session_missing'
        throw failure
      }
    },

    async sendTurn(handle, turn) {
      const entry = entryFor(handle.sessionId)
      // A capture or failure from the previous turn must never satisfy this one.
      entry.captured = undefined
      entry.lastText = ''
      entry.turnError = undefined
      entry.schema = turn.schema
      const content = [{ type: 'text', text: turn.text }]
      const agent = handle.agent
      if (agent !== undefined && typeof agent.followup === 'function') {
        // The live receiver has no durable-continuation requirement: this is the
        // same inbox the user's own messages enter.
        agent.followup({
          id: `wfmsg-${randomUUID()}`,
          role: 'user',
          content,
          source: { kind: 'user' },
          time: Date.now(),
        })
      } else {
        // No live agent handle: the send itself is the whole operation, and
        // `whenIdle` would be a call on undefined.
        await subagents.sendMessage(
          parentAgent,
          handle.sessionId,
          content,
          signal === undefined ? {} : { signal },
        )
        return
      }
      await agent.whenIdle()
      if (entry.turnError !== undefined) throw new Error(entry.turnError)
    },

    async readReply(handle) {
      const entry = entryFor(handle.sessionId)
      if (entry.captured !== undefined) return { structured: true, value: entry.captured }
      return entry.lastText
    },

    async dispose(handle) {
      sessions.delete(handle.sessionId)
      try {
        await handle.dispose()
      } catch {
        // the agent may already be gone
      }
    },

    /** Release the session subscription when the run ends. */
    close() {
      try {
        off()
      } catch {
        // teardown is not an error
      }
    },
  }
}

/**
 * Build the `exec` the world reader needs: confine, then spawn, never a shell.
 *
 * @param {object} input
 * @param {object} input.sandbox `ctx.sandbox`
 * @param {object} input.sandboxPolicy `ctx.sandboxPolicy`
 * @param {object} input.subprocess `ctx.subprocess`
 * @param {object} [input.session] the calling Session, for its policy
 * @param {string} input.cwd
 * @returns {(argv: readonly string[], options: { timeoutMs?: number }) => Promise<{ exitCode: number|null, stdout: string, stderr: string, timedOut?: boolean }>}
 */
export function createHostExec({ sandbox, sandboxPolicy, subprocess, session, cwd }) {
  return async function exec(argv, { timeoutMs = 300_000 } = {}) {
    const policy = sandboxPolicy.resolve(session === undefined ? {} : { session })
    let spawnArgv = [...argv]
    if (policy.mode !== 'danger-full-access') {
      // `confine` takes the exact argv about to be spawned — never a shell
      // string — and returns what to spawn instead.
      const confined = await sandbox.confine(spawnArgv, {
        mode: policy.mode,
        workspaceRoot: policy.workspaceRoot,
        ...(policy.additionalWritableRoots === undefined
          ? {}
          : { additionalWritableRoots: policy.additionalWritableRoots }),
        ...(policy.sessionId === undefined ? {} : { sessionId: policy.sessionId }),
      })
      spawnArgv = confined.argv
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort('timeout'), Math.max(1, timeoutMs))
    try {
      const handle = subprocess.spawn({
        argv: spawnArgv,
        cwd,
        stdio: {
          stdin: 'ignore',
          // Deliberately ABOVE the world limit (256 KiB): capping the transport at
          // the same number silently truncated a 300 KB stdout into a "successful"
          // read, so the caller could never detect the loss. The transport keeps a
          // bigger ceiling and the world layer rejects what exceeds its own.
          stdout: { maxBytes: 4 * 1024 * 1024, spill: { maxBytes: 16 * 1024 * 1024 } },
          stderr: { maxBytes: 4 * 1024 * 1024, spill: { maxBytes: 16 * 1024 * 1024 } },
        },
        graceMs: 2_000,
        signal: controller.signal,
      })
      const outcome = await handle.done
      const read = (name) => {
        const reader = handle.collected?.[name]
        if (reader === undefined) return { text: '', lossy: false }
        return reader.readFrom(0)
      }
      const stdout = read('stdout')
      const stderr = read('stderr')
      const timedOut = controller.signal.aborted === true
      // A lossy read means bytes were dropped: report it instead of letting a
      // truncated string look like a complete output.
      const lossy = stdout.lossy === true || stderr.lossy === true
        || stdout.truncated === true || stderr.truncated === true
      return {
        exitCode: outcome.exitCode,
        stdout: stdout.text,
        stderr: stderr.text,
        ...(timedOut ? { timedOut: true } : {}),
        ...(lossy ? { truncated: true } : {}),
      }
    } finally {
      clearTimeout(timer)
    }
  }
}
