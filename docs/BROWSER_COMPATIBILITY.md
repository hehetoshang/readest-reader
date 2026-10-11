# Chrome 96 兼容目标

Reader 入口 `src/pages/reader.moke.tsx` 在其他阅读组件之前加载
`src/utils/polyfill.ts`。构建目标不会自动补齐运行时 API，因此显式加载
core-js 的 `findLastIndex`、`structuredClone`，并补齐原生 AbortSignal 缺失的
`reason`、`throwIfAborted`、`abort(reason)`、`timeout` 和 `any`。
现代浏览器保留其原生取消 API；旧浏览器继续使用原生 AbortController，
避免以自定义信号对象破坏 fetch/Request 的真实取消。

core-js 提供备份/同步所需的类型与循环引用克隆及 PDF fake-worker 所需的
ArrayBuffer 转移。其他浏览器对象的克隆/转移仍受 core-js 和底层浏览器能力限制，
不使用会丢失数据的 JSON 克隆回退。PDF worker 自带 PDF.js legacy 兼容代码；
这次没有修改生成资产或降级 PDF.js。

取消组合在任一输入中止后移除输入监听器；已中止或无效输入不会留下监听器。
超时回退使用浏览器定时器，长时间通过分段调度防止 32 位溢出。它不模拟现代
原生 timeout 的完整 active-time / BFCache 暂停语义。段落弹层使用带 `vh` 回退
的视口变量，不依赖 Chrome 108 才支持的 `dvh`。

## 验证与限制

`pnpm test` 覆盖移除新 API 后的备份、二进制转移、最后一个线性 EPUB 章节、
取消原因、超时及监听器清理。另运行 `pnpm typecheck`、`pnpm lint`、`pnpm build`。

Chrome 96 是集成兼容目标，不是 Next.js/PDF.js 上游支持声明。
现代 Chromium 的能力限制测试不能替代真实 Chrome 96 / 原生 WebView 验收。
发布前需验证完整阅读界面、EPUB/PDF、目录与翻页、翻译取消、备份恢复及错误恢复。
