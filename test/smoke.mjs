/**
 * 服务端冒烟：mock cordis 瀑布 + 会话服务，验证补丁语义，不发真实网络。
 * 约定：node test/smoke.mjs，零依赖（不读 node_modules 产物）。
 */
import { apply, REVIEW_MARKER } from '../lib/index.js'

const REVIEW_SYSTEM = `REVIEW_POLICY\nYou are the ${REVIEW_MARKER} for exactly one pending tool call.`

function reviewOptions() {
  return Object.freeze({
    provider: 'opencode-go',
    model: 'test-model',
    system: REVIEW_SYSTEM,
    messages: Object.freeze([{ role: 'user', content: Object.freeze([{ type: 'text', text: 'PENDING' }]) }]),
    temperature: 0,
  })
}

async function drain(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

// 与 vendor/cordis events.ts waterfall 同语义的最小复刻：
// next() 永远用原参数调下一个监听，重发新对象会开一条新瀑布。
function createCtx(sessions) {
  const hooks = { 'tools/pre-execute': [], 'llm/stream': [] }
  const captured = []
  const ctx = {
    _hooks: hooks,
    _captured: captured,
    sessions: { list: () => sessions },
    permissionPresets: { current: (s) => s.preset },
    llm: {},
    on: (event, cb, opts) => {
      const arr = hooks[event] ??= []
      if (opts !== null && typeof opts === 'object' && opts.prepend) arr.unshift(cb)
      else arr.push(cb)
      return () => {
        const i = arr.indexOf(cb)
        if (i >= 0) arr.splice(i, 1)
      }
    },
  }
  async function* adapter(options) {
    captured.push(options)
    if (typeof options?.system === 'string'
      && options.system.includes(REVIEW_MARKER)
      && options?.sessionId === undefined) {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'INVALID_REQUEST', message: 'MissingSessionID' } } }
      return
    }
    const text = '{"risk":"low","decision":"allow"}'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  ctx.llm.stream = (options) => {
    const cbs = [...hooks['llm/stream']]
    const inner = () => adapter(options)
    let i = 0
    const next = () => {
      const cb = i < cbs.length ? cbs[i++] : inner
      return cb(options, next)
    }
    return next()
  }
  return ctx
}

function firePreExecute(ctx, sessionId) {
  const cbs = [...ctx._hooks['tools/pre-execute']]
  let i = 0
  const next = () => {
    const cb = i < cbs.length ? cbs[i++] : () => Promise.resolve({ kind: 'allow' })
    return cb({ agent: { session: { id: sessionId } } }, next)
  }
  return next()
}

async function smoke() {
  // 1. 跟踪路径：pre-execute 记住的会话 id 被补上，原冻结对象不动。
  {
    const ctx = createCtx([{ id: 'sess-1', preset: 'auto' }])
    apply(ctx)
    await firePreExecute(ctx, 'sess-1')
    const options = reviewOptions()
    const chunks = await drain(ctx.llm.stream(options))
    if (chunks.at(-1)?.reason?.kind !== 'stop') throw new Error('case1: patched review should stop')
    if (ctx._captured.length !== 1) throw new Error('case1: adapter should see exactly one call')
    if (ctx._captured[0].sessionId !== 'sess-1') throw new Error('case1: sessionId not patched')
    if ('sessionId' in options) throw new Error('case1: frozen original must stay untouched')
    if (!Object.isFrozen(options)) throw new Error('case1: original must stay frozen')
  }

  // 2. 兜底路径：无跟踪、单 auto 会话时从会话列表取。
  {
    const ctx = createCtx([{ id: 'sess-9', preset: 'auto' }])
    apply(ctx)
    const chunks = await drain(ctx.llm.stream(reviewOptions()))
    if (chunks.at(-1)?.reason?.kind !== 'stop') throw new Error('case2: fallback review should stop')
    if (ctx._captured[0].sessionId !== 'sess-9') throw new Error('case2: fallback sessionId wrong')
  }

  // 3. 非评审的无会话请求原样放行。
  {
    const ctx = createCtx([{ id: 'sess-1', preset: 'auto' }])
    apply(ctx)
    const plain = Object.freeze({ provider: 'p', model: 'm', messages: [] })
    await drain(ctx.llm.stream(plain))
    if (ctx._captured[0].sessionId !== undefined) throw new Error('case3: non-review must not gain sessionId')
  }

  // 4. 已带 sessionId 的评审请求不动。
  {
    const ctx = createCtx([{ id: 'sess-1', preset: 'auto' }])
    apply(ctx)
    const options = Object.freeze({ ...reviewOptions(), sessionId: 'keep-me' })
    await drain(ctx.llm.stream(options))
    if (ctx._captured[0].sessionId !== 'keep-me') throw new Error('case4: existing sessionId must win')
    if (ctx._captured.length !== 1) throw new Error('case4: must not re-dispatch')
  }

  // 5. 拿不到会话时 fail-open：不崩，原始错误透出。
  {
    const ctx = createCtx([])
    apply(ctx)
    const chunks = await drain(ctx.llm.stream(reviewOptions()))
    const last = chunks.at(-1)
    if (last?.reason?.kind !== 'error'
      || last.reason.failure?.code !== 'INVALID_REQUEST') {
      throw new Error('case5: should fail open with original gateway error')
    }
  }

  console.log('smoke ok: track + fallback + passthrough + keep + fail-open pass')
}

await smoke()
