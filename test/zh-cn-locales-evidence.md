# 简体中文包定向验收

结论：4 项定向测试通过，退出码 0。只验收本次语言包、设置控件与定向测试。未运行全量测试或格式化。未提交或推送。

## 本会话负责的文件

- `src/server/extensions/zh-cn.ts`
- `src/server/extensions/zh-cn/messages.ts`
- `web/sheets/appearance.js`
- `test/zh-cn-locales.test.ts`
- `test/zh-cn-locales-ui.test.ts`
- 本证据文件。

工作树有其他会话的并行改动。下面保留完整 status，不能将其他路径归入本会话，也不能声称 status 仅包含本范围。

## 对齐与保留

- 对齐前 6847 条，覆盖 719/836 个英文键。
- 新增 117 条中文后，共 6964 条，覆盖 836/836，缺失 0。
- 保留 6128 个尚未进入英文目录的键；核心按现有规则不发布它们。
- 原 6847 条逐项比较通过，除获准键名改动外，原值全部不变。
- 唯一改名：`server.extensions.design.workspace.create-workspace.empty.ideas.make-clickable-prototype-habit` → `server.extensions.design.workspace.create-workspace.empty.ideas.make-habit-clickable`。
- 按核心相同的分段规则扫描 `prototype`、`__proto__`、`constructor`，改后 0 项。
- 外部 DRAFT 文件未修改。
- 英文目录验收 SHA-256：`172d5441795fd0dd269d71dd9859629d980c1f88cced1d036d6e00bd58947338`。

## 字节与长度

`du -b src/server/extensions/zh-cn/messages.ts`，退出码 0，原文：

`721210\tsrc/server/extensions/zh-cn/messages.ts`

声明 JSON 为 627758 字节，低于 1 MiB 单声明和 4 MiB 总语言上限。最长键 120 字符，最长值 4249 UTF-8 字节，低于 160 字符和 8192 字节上限。

## 核心校验

命令：

`node --input-type=module -e 'import {checkUiLocales} from "./src/server/ui-locales.ts"; import pack from "./src/server/extensions/zh-cn/messages.ts"; const checked=checkUiLocales("zh-CN",[pack]); console.log("checkUiLocales(\"zh-CN\", [pack]): accepted"); console.log("declared messages:",Object.keys(pack.messages).length); console.log("published messages:",Object.keys(checked[0].messages).length);'`

退出码 0。完整标准输出：

- `checkUiLocales("zh-CN", [pack]): accepted`
- `declared messages: 6964`
- `published messages: 836`

## 定向测试

命令：`node --test test/zh-cn-locales.test.ts test/zh-cn-locales-ui.test.ts`。退出码 0。完整日志：

```text
✔ 390 x 844: the language control switches to Chinese, survives disable, and restores the preference (1605.814423ms)
ℹ Measured phone/control geometry: {"width":390,"height":844,"selectHeight":41.78125,"left":87.171875,"right":367,"scrollWidth":390,"clientWidth":390,"selected":"en","label":"简体中文"}
✔ the Chinese data has valid keys, matching placeholders, and fits all locale limits (70.500286ms)
✔ the real built-in module registers Chinese and resolves 10 translated messages (29.964425ms)
✔ invalid Chinese updates are refused and keep the previously registered pack (85.851472ms)
ℹ tests 4
ℹ suites 0
ℹ pass 4
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 6464.384687

```

移动端真实 Chromium 使用 390×844。选择器实测高 41.78125 px。页面 scrollWidth/clientWidth 均为 390。实际选择后标题由 Appearance 变为外观，无页面刷新。停用真实模块后回到英文，重新启用后恢复中文偏好。非法更新覆盖非字符串、危险键段、超长值和占位符不匹配，真实 loader 拒绝更新且保留原目录。

UI 模块断言使用实际外部接口 `(await app.extensions(owner(app))).modules`，不再直接依赖 `app.loader.list()`。

## 语法检查

命令：`node --check web/sheets/appearance.js && node --check src/server/extensions/zh-cn.ts && node --check src/server/extensions/zh-cn/messages.ts && node --check test/zh-cn-locales.test.ts && node --check test/zh-cn-locales-ui.test.ts`。退出码 0，无标准输出。

## 改前失败证据

同一测试命令改前退出码 1，4 项失败，无跳过。它们分别在缺包或缺模块处失败，后续行为断言当时未到达。非法包拒收由原核心实现，不声称是本次新增的能力。

```text
✖ 390 x 844: the language control switches to Chinese, survives disable, and restores the preference (2.34723ms)
✖ the Chinese data has valid keys, matching placeholders, and fits all locale limits (1.358346ms)
✖ the real built-in module registers Chinese and resolves 10 translated messages (1.242409ms)
✖ invalid Chinese updates are refused and keep the previously registered pack (1.931325ms)
ℹ tests 4
ℹ suites 0
ℹ pass 0
ℹ fail 4
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1194.409301

✖ failing tests:

test at test/zh-cn-locales-ui.test.ts:37:1
✖ 390 x 844: the language control switches to Chinese, survives disable, and restores the preference (2.34723ms)
  AssertionError [ERR_ASSERTION]: the built-in Chinese module exists
      at TestContext.<anonymous> (file:///home/xianbei233/Work/pi-pocket-pr/test/zh-cn-locales-ui.test.ts:38:12)
      at Test.runInAsyncScope (node:async_hooks:226:14)
      at Test.run (node:internal/test_runner/test:1402:25)
      at Test.start (node:internal/test_runner/test:1262:17)
      at startSubtestAfterBootstrap (node:internal/test_runner/harness:387:17) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: false,
    expected: true,
    operator: '==',
    diff: 'simple'
  }

test at test/zh-cn-locales.test.ts:56:1
✖ the Chinese data has valid keys, matching placeholders, and fits all locale limits (1.358346ms)
  Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/home/xianbei233/Work/pi-pocket-pr/src/server/extensions/zh-cn/messages.ts' imported from /home/xianbei233/Work/pi-pocket-pr/test/zh-cn-locales.test.ts
      at finalizeResolution (node:internal/modules/esm/resolve:241:11)
      at moduleResolve (node:internal/modules/esm/resolve:846:10)
      at defaultResolve (node:internal/modules/esm/resolve:973:11)
      at #cachedDefaultResolve (node:internal/modules/esm/loader:708:20)
      at #resolveAndMaybeBlockOnLoaderThread (node:internal/modules/esm/loader:728:38)
      at ModuleLoader.resolveSync (node:internal/modules/esm/loader:766:56)
      at #resolve (node:internal/modules/esm/loader:690:17)
      at ModuleLoader.getOrCreateModuleJob (node:internal/modules/esm/loader:610:35)
      at node:internal/modules/esm/loader:639:32
      at TracingChannel.tracePromise (node:diagnostics_channel:551:22) {
    code: 'ERR_MODULE_NOT_FOUND',
    url: 'file:///home/xianbei233/Work/pi-pocket-pr/src/server/extensions/zh-cn/messages.ts'
  }

test at test/zh-cn-locales.test.ts:84:1
✖ the real built-in module registers Chinese and resolves 10 translated messages (1.242409ms)
  Error: There is no extension module zh-cn.ts
      at #load (file:///home/xianbei233/Work/pi-pocket-pr/src/server/reload.ts:612:19)
      at #reload (file:///home/xianbei233/Work/pi-pocket-pr/src/server/reload.ts:550:36)
      at ExtensionLoader.reload (file:///home/xianbei233/Work/pi-pocket-pr/src/server/reload.ts:544:35)
      at TestContext.<anonymous> (file:///home/xianbei233/Work/pi-pocket-pr/test/zh-cn-locales.test.ts:88:39)
      at Test.runInAsyncScope (node:async_hooks:226:14)
      at Test.run (node:internal/test_runner/test:1402:25)
      at Test.processPendingSubtests (node:internal/test_runner/test:974:18)
      at Test.postRun (node:internal/test_runner/test:1542:19)
      at Test.run (node:internal/test_runner/test:1467:12)
      at async startSubtestAfterBootstrap (node:internal/test_runner/harness:387:3)

test at test/zh-cn-locales.test.ts:110:1
✖ invalid Chinese updates are refused and keep the previously registered pack (1.931325ms)
  Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/home/xianbei233/Work/pi-pocket-pr/src/server/extensions/zh-cn.ts' imported from /tmp/pi-pocket-test-2FrotM/zh-cn-loader-6LHL5N/zh-cn.ts
      at finalizeResolution (node:internal/modules/esm/resolve:241:11)
      at moduleResolve (node:internal/modules/esm/resolve:846:10)
      at defaultResolve (node:internal/modules/esm/resolve:973:11)
      at #cachedDefaultResolve (node:internal/modules/esm/loader:708:20)
      at #resolveAndMaybeBlockOnLoaderThread (node:internal/modules/esm/loader:728:38)
      at ModuleLoader.resolveSync (node:internal/modules/esm/loader:766:56)
      at #resolve (node:internal/modules/esm/loader:690:17)
      at ModuleLoader.getOrCreateModuleJob (node:internal/modules/esm/loader:610:35)
      at ModuleJob.syncLink (node:internal/modules/esm/module_job:277:33)
      at ModuleJob.link (node:internal/modules/esm/module_job:389:17) {
    code: 'ERR_MODULE_NOT_FOUND',
    url: 'file:///home/xianbei233/Work/pi-pocket-pr/src/server/extensions/zh-cn.ts'
  }

```

## 10 个抽样

| 键                  | 英文        | 中文     |
| ------------------- | ----------- | -------- |
| ui.close            | Close       | 关闭     |
| app.menu            | Menu        | 菜单     |
| app.files           | Files       | 文件     |
| menu.appearance     | Appearance  | 外观     |
| appearance.title    | Appearance  | 外观     |
| appearance.language | Language    | 语言     |
| appearance.theme    | Theme       | 主题     |
| appearance.colors   | Colors      | 配色     |
| sessions.new        | New session | 新建会话 |
| signin.name-label   | Your name   | 你的名字 |

## 完整工作树状态

命令：`git status --porcelain=v1 --untracked-files=all`。退出码 0。以下为记录本证据前的完整原文，尚不包含本证据文件：

```text
 M src/server/design/docsite-color-section.ts
 M src/server/design/docsite-components.ts
 M src/server/design/docsite-core.ts
 M src/server/design/docsite-reference.ts
 M src/server/design/docsite-space.ts
 M src/server/design/docsite-type.ts
 M src/server/design/docsite.ts
 M src/server/extensions/ask-someone.ts
 M src/server/http/artifacts.ts
 M test/extension-loader.test.ts
 M test/ui-locale-ui.test.ts
 M test/ui-locales-http.test.ts
 M test/ui-locales.test.ts
 M test/voice.test.ts
 M web/app.js
 M web/browser-panel.js
 M web/chat.js
 M web/composer.js
 M web/diff.js
 M web/extension-ui.js
 M web/files-panel.js
 M web/home.js
 M web/launcher.js
 M web/linked-sessions.js
 M web/locales/en.js
 M web/model-refresh.js
 M web/notify.js
 M web/peeks.js
 M web/pip.js
 M web/quote-reply.js
 M web/rich.js
 M web/sessions.js
 M web/share.js
 M web/sheets.js
 M web/sheets/appearance.js
 M web/sheets/branch.js
 M web/sheets/extensions.js
 M web/sheets/file.js
 M web/sheets/find.js
 M web/sheets/folder.js
 M web/sheets/gallery.js
 M web/sheets/hooks.js
 M web/sheets/memory.js
 M web/sheets/menu.js
 M web/sheets/message.js
 M web/sheets/model.js
 M web/sheets/people.js
 M web/sheets/pi-sessions.js
 M web/sheets/providers.js
 M web/sheets/running.js
 M web/sheets/schedules.js
 M web/sheets/shortcuts.js
 M web/sheets/spend.js
 M web/sheets/text.js
 M web/sheets/viewers.js
 M web/sheets/worktree.js
 M web/subagents-board.js
 M web/subagents.js
 M web/transcript.js
 M web/trust.js
 M web/ui.js
 M web/voice.js
?? src/server/extensions/zh-cn.ts
?? src/server/extensions/zh-cn/messages.ts
?? test/request-locale-pages-evidence.md
?? test/request-locale-pages.test.ts
?? test/zh-cn-locales-ui.test.ts
?? test/zh-cn-locales.test.ts

```

## 未覆盖与限制

未执行全量 npm test、npm run format、全量 lint/check。未部署到线上，未更改线上数据，未提交或推送。

只验证本轮 836 个英文键的可发布性；后续英文目录增加时仍需补齐。Appearance 其他文案仍由整合会话负责，不扩大本次修改范围。
