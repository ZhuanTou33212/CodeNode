# 脚本目录

[English](README.md) · [简体中文](README.zh-CN.md)

按执行用途存放脚本；分类迁移不改变 npm 命令、断言或测试组。文件所在目录不代表它会自动执行，实际测试集合以 `run-all-tests.cjs` 为准。

| 位置 | 用途 | 入口 |
| --- | --- | --- |
| 根目录的 6 个 `.cjs` | 开发启动、构建、图标、发布签名、启动器和测试调度 | `npm run dev`、`npm run build`、`npm run dist:win`、`npm run verify` |
| `core/` | 无需界面的功能回归、权限边界、存储与运行门禁 | `npm test`；专项测试见 `package.json` |
| `ui/` | Electron / 浏览器界面测试、截图与主题检查 | `npm run test:display`；未注册用例通过 `run-electron.cjs` 或脚本自身说明运行 |
| `packaged/` | 对实际 `app.asar` 的启动、工具和界面验收 | 设置 `CODENODE_PACKAGED_ASAR`，再通过 `run-electron.cjs` 运行 |
| `eval/` | 数据集、评测、消融实验及可选本地模型服务 | `npm run test:eval`、`npm run rag:acceptance`；其他脚本见自身参数说明 |
| `tools/` | 事件回放、图像与视觉专项检查工具 | 见各脚本的用法说明 |
| `lib/` | 脚本共用的模型桩、源码读取与检查函数 | 由测试或评测脚本导入 |
| `fixtures/` | 测试输入、冻结数据集和锁文件 | 由脚本读取，不能当缓存删除 |

## 常用验证

```powershell
npm run test:list                 # 当前 core / display 集合和数量
npm run verify                    # 构建 + CJS 静态检查 + core 回归
npm run test:display               # 需要 Electron 或浏览器
node scripts/run-all-tests.cjs --only test:session,test:undo
node scripts/run-electron.cjs scripts/ui/theme-parity-ui-test.cjs
$env:CODENODE_PACKAGED_ASAR = 'E:\CodeNode\release\win-unpacked\resources\app.asar'
node scripts/run-electron.cjs scripts/packaged/packaged-startup-check.cjs
```

`eval/` 包含离线评测和真实模型实验。目录分类不改变脚本原有的凭据、发送确认或冻结基线要求；按脚本说明选择模式。

冻结归档的说明和哈希保留其当时的目录结构。校验原始材料使用 `node baselines/rag-regression-v3/verify.cjs`；归档中的 `--check-host-evaluator` 用于核对当时的宿主脚本，当前迁移后的脚本路径和哈希已有变化。使用当前 `eval/` 重新评测时须写入新报告，不能覆盖旧成绩或声称与冻结评测器逐字节一致。

## 维护规则

- 新测试放到对应分类，公共辅助代码放 `lib/`，输入数据放 `fixtures/`。
- 注册 npm 命令，并根据执行条件决定是否加入 `run-all-tests.cjs` 的 core / display 集合。现有手工探针和专项验收保留，不因为没有进入默认集合就删除。
- 移动文件时同步模块导入、`__dirname` 路径、npm 命令、CI / CODEOWNERS 与文档示例；验证测试集合未改变。
- 生成报告写入 `out/` 或既定报告目录。已被文档、基线或审查材料引用的报告保留；临时文件删除前检查实际引用和运行占用。
