/**
 * Trace / Span 生命周期测试
 *
 * 验证 U01：Span 活动栈管理正确、withSpan 在所有退出路径恢复父上下文、
 * 多 Tracer 实例活动栈互相隔离、模块级便捷函数委托给活跃 Tracer。
 *
 * 运行：node --test test/trace.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Tracer, createTracer, getCurrentSpan } from '../src/trace/index.js'

const TRACE_ID = 'a'.repeat(32)

test('withSpan 同步：结束后从活动栈弹出，current 恢复为 null', () => {
  const tracer = new Tracer({ traceId: TRACE_ID })
  assert.equal(tracer.getCurrentSpan(), null)
  tracer.withSpan('sync', (span) => {
    assert.equal(tracer.getCurrentSpan(), span)
    assert.equal(span.isEnded(), false)
  })
  assert.equal(tracer.getCurrentSpan(), null)
  // span 已被 endSpan 关闭
  assert.equal(tracer._spanStack.length, 0)
})

test('withSpan 同步：父子关系正确（parentSpanId = 父 spanId）', () => {
  const tracer = createTracer({ traceId: TRACE_ID })
  const root = tracer.createRootSpan('page')
  tracer.withSpan('child', (child) => {
    assert.equal(child.context.parentSpanId, root.context.spanId)
    assert.equal(child.context.traceId, root.context.traceId)
  })
  // child 已弹出，current 回到 root
  assert.equal(tracer.getCurrentSpan(), root)
})

test('withSpan 嵌套：孙 span 的 parent 是子 span，退出后逐层恢复', () => {
  const tracer = new Tracer({ traceId: TRACE_ID })
  tracer.createRootSpan('page')
  tracer.withSpan('a', (a) => {
    tracer.withSpan('b', (b) => {
      assert.equal(b.context.parentSpanId, a.context.spanId)
    })
    // b 已弹出，current 回到 a
    assert.equal(tracer.getCurrentSpan(), a)
  })
  // a 已弹出，current 回到 root
  assert.equal(tracer.getCurrentSpan()?.name, 'page')
})

test('withSpan 异步 resolve：结束后弹出，current 恢复为 root', async () => {
  const tracer = new Tracer({ traceId: TRACE_ID })
  tracer.createRootSpan('page')
  await tracer.withSpan('async', async (span) => {
    assert.equal(tracer.getCurrentSpan(), span)
    await Promise.resolve()
  })
  assert.equal(tracer.getCurrentSpan()?.name, 'page')
})

test('withSpan 异步 reject：记录异常、弹出栈并向上抛出', async () => {
  const tracer = new Tracer({ traceId: TRACE_ID })
  tracer.createRootSpan('page')
  const boom = new Error('async-boom')
  await assert.rejects(
    () => tracer.withSpan('async-fail', async () => { throw boom }),
    /async-boom/
  )
  // span 已被 endSpan 弹出，current 回到 root
  assert.equal(tracer.getCurrentSpan()?.name, 'page')
})

test('withSpan 同步异常：记录异常、弹出栈、原异常继续抛出', () => {
  const tracer = new Tracer({ traceId: TRACE_ID })
  tracer.createRootSpan('page')
  const syncBoom = new Error('sync-boom')
  assert.throws(() => tracer.withSpan('sync-fail', () => { throw syncBoom }), /sync-boom/)
  assert.equal(tracer.getCurrentSpan()?.name, 'page')
})

test('多实例：活动栈互相隔离，互不污染', () => {
  const t1 = new Tracer({ traceId: '1'.repeat(32) })
  const t2 = new Tracer({ traceId: '2'.repeat(32) })
  const r1 = t1.createRootSpan('page')

  // t2 看不到 t1 的 root span
  assert.equal(t2.getCurrentSpan(), null)

  t1.withSpan('s1', (s1) => {
    assert.equal(t1.getCurrentSpan(), s1)
    assert.equal(t2.getCurrentSpan(), null)
  })
  // t1 的 s1 已弹出，current 回到 r1；t2 始终为空
  assert.equal(t1.getCurrentSpan(), r1)
  assert.equal(t2.getCurrentSpan(), null)
})

test('createTracer 注册活跃 Tracer，模块级 getCurrentSpan 委托正确', () => {
  const tracer = createTracer({ traceId: TRACE_ID })
  tracer.createRootSpan('page')
  // 模块级便捷函数应委托给活跃 Tracer
  assert.equal(getCurrentSpan(), tracer.getCurrentSpan())
})

test('startSpan 手动结束：endSpan 弹出并关闭 span', () => {
  const tracer = new Tracer({ traceId: TRACE_ID })
  tracer.createRootSpan('page')
  const span = tracer.startSpan('manual')
  assert.equal(tracer.getCurrentSpan(), span)
  tracer.endSpan(span)
  assert.equal(tracer.getCurrentSpan()?.name, 'page')
  assert.equal(span.isEnded(), true)
})

test('重复 endSpan 幂等：不抛错、不重复弹栈', () => {
  const tracer = new Tracer({ traceId: TRACE_ID })
  tracer.createRootSpan('page')
  const span = tracer.startSpan('manual')
  tracer.endSpan(span)
  const stackLenAfterFirst = tracer._spanStack.length
  tracer.endSpan(span) // 第二次应安全无操作
  assert.equal(tracer._spanStack.length, stackLenAfterFirst)
  assert.equal(span.isEnded(), true)
})
