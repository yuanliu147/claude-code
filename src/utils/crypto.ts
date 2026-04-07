// package.json "browser" 字段的间接指向点。当 bun 使用 --target browser 构建
// browser-sdk.js 时，此文件会被替换为 crypto.browser.ts — 这样可以避免 Bun
// 为 `import ... from 'crypto'` 内联约 500KB 的 crypto-browserify polyfill。
// Node/bun 构建使用此文件不做更改。
//
// 注意：`export { randomUUID } from 'crypto'`（重导出语法）在 bun-internal 的字节码编译下会出错
// — 生成的字节码显示了 import 但绑定未链接（`ReferenceError: randomUUID is not
// defined`）。下面的显式 import-then-export 产生正确的实时绑定。
// 详见 PR #20957/#21178 上 integration-tests-ant-native 的失败情况。
import { randomUUID } from 'crypto'
export { randomUUID }
