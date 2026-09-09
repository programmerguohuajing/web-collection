// 最小类型垫片：让测试文件在 tsc 编译阶段认得 Node 内置模块（不引入 @types/node 依赖）。
declare module 'node:test' {
  export function test(name: string, fn: (t?: unknown) => void | Promise<void>): void
  export function describe(name: string, fn: () => void): void
  export const before: (fn: () => void | Promise<void>) => void
  export const after: (fn: () => void | Promise<void>) => void
}
declare module 'node:assert/strict' {
  const assert: {
    ok(value: unknown, message?: string): void
    equal(a: unknown, b: unknown, message?: string): void
    deepEqual(a: unknown, b: unknown, message?: string): void
    fail(message?: string): void
  }
  export default assert
}
declare module 'node:fs' {
  export function readFileSync(path: string, encoding?: string): string
}
declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string
}
