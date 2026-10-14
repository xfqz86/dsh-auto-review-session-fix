/**
 * 补丁插件：给 auto-review 的评审请求补上 sessionId。
 *
 * 背景：评审调用只走 ctx.llm.stream 且故意不带 sessionId，
 * 主链路（agent-loop）与压缩任务都会带。opencode-go 网关要求
 * x-opencode-session 路由头（pi-ai 靠 options.sessionId 注入），
 * 缺了就 400 MissingSessionID，连 read 都过不了 auto 评审。
 *
 * 做法：只认评审请求（system 里带固定标记），克隆一份补上
 * sessionId 再重发一次 ctx.llm.stream。原冻结对象不动；
 * 带 sessionId 的重发第二次进瀑布直接放行，不会递归。
 * 拿不到会话时放行（fail-open），让原始报错透出而不是崩。
 *
 * 纯 JS，无构建：lib/ 即源码，与 dsh-web-fetch-allowlist 同形态。
 * ctx 只用鸭子类型，不导入 cordis 与 harness 类型。
 *
 * @module dsh-auto-review-session-fix
 */

/** Cordis 插件名（加载诊断用）。 */
export const name = 'auto-review-session-fix'

/** 启动顺序依赖：llm 事件、会话列表、预设判断、工具预执行跟踪。 */
export const inject = ['llm', 'sessions', 'permissionPresets', 'tools']

/** 评审 system 提示里的稳定标记（REVIEW_POLICY 首句片段）。 */
export const REVIEW_MARKER = 'final authorization reviewer'

/** auto 预设 id（与 harness 内 AUTO_PRESET 同值，纯 JS 里直接写字符串）。 */
const AUTO_PRESET_ID = 'auto'

/**
 * 注册补丁链路。
 * @param {{ on: Function, llm: { stream: Function }, sessions: { list: Function }, permissionPresets: { current: Function } }} ctx cordis 上下文（鸭子类型）
 */
export function apply(ctx) {
  // 最近一次工具预执行的归属会话。评审跑在该事件链里，
  // 无论相对 auto-review 的监听顺序如何，只要在本插件监听之后
  // 触发评审流，取值都已就绪；并发错配也只是路由次优，不会 400。
  let lastSessionId

  // 必须 prepend：与 auto-review 同为 prepend 时后加载者居前，
  // profile 补丁层本来就加载在 auto-review bundle 之后。
  // 只记录、不拦截，立刻放行。
  ctx.on('tools/pre-execute', (exec, next) => {
    try {
      const id = exec?.agent?.session?.id
      if (id !== undefined) lastSessionId = id
    } catch {
      // 会话形状异常时忽略，靠兜底路径。
    }
    return next()
  }, { prepend: true })

  // prepend：让其他 llm 中间件看到的永远是补全后的请求。
  ctx.on('llm/stream', (options, next) => {
    if (options?.sessionId !== undefined) return next()
    const system = options?.system
    if (typeof system !== 'string' || !system.includes(REVIEW_MARKER)) return next()

    let sid = lastSessionId
    if (sid === undefined) {
      try {
        const autos = ctx.sessions.list().filter((session) => {
          try {
            return ctx.permissionPresets.current(session) === AUTO_PRESET_ID
          } catch {
            return false
          }
        })
        if (autos.length === 1) sid = autos[0].id
      } catch {
        // 会话服务异常时放行。
      }
    }
    if (sid === undefined) return next()
    // 原对象被评审侧 deepFreeze，展开成新对象再重发。
    return ctx.llm.stream({ ...options, sessionId: sid })
  }, { prepend: true })
}
