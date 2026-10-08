# 发布流程

目标：**任何一次发布都能被第三方独立验证**——产物有哈希清单、有签名、有自检报告，且版本号只有一个来源。

## 1. 版本号（唯一来源）

- `package.json` 的 `version` 是唯一来源；`electron/selfTest.cjs` 会把 `git` 提交号与版本号一起输出到自检 JSON。
- 标签格式 `vX.Y.Z`（对齐 `package.json`）：

```bash
npm version 0.14.0 --no-git-tag-version   # 只改 package.json/package-lock.json
npm run verify                            # 门禁全绿再提交
git commit -am "chore(release): 版本号 0.14.0"
git tag v0.14.0
git push origin yimi-branch --tags
```

> 历史教训：仓库里同时存在 `0.11 / 0.12 / 0.13 / n0_11 / v0.12.0 / v0.3.0 / v0.3.1` 等标签，
> 与 `package.json` 的版本号对不上，导致"代码 / 产物 / 标签"三者无法互相追溯。从本流程起统一为 `vX.Y.Z`。

## 2. 本地预检（发布前必跑）

```bash
npm run verify                    # build + check:js + core 套件（集合以 test:list 为准）
npm run test:display                # 需要窗口 / 浏览器的用例（smoke、RAG UI、矢量画布）
New-Item -ItemType Directory -Path out/release-selftest/userData,out/release-selftest/project -Force
node scripts/run-electron.cjs . --codenode-selftest --codenode-user-data-dir=out/release-selftest/userData --codenode-selftest-project=out/release-selftest/project --codenode-selftest-seed
# 在隔离目录发布自检：JSON 中 ok:true 才算通过；验收后清理隔离数据。
```

## 3. 打包

```bash
npm run dist:win     # 便携包 + 启动器；产物在 release/
npm run dist:mac     # dmg + zip
npm run dist:linux   # AppImage + deb
```

## 4. 签名与哈希清单（必做）

```bash
npm run release:hash   # 只生成 sha256/sha512 清单与校验（不签名，CI 可跑）
npm run release:sign   # 用证书签名（Windows 走 signtool）
```

- Windows 签名凭据（CI：`production-gate.yml` 的 release 模式强制校验，缺一即失败）：
  `CODENODE_WIN_CERT_PFX_BASE64`、`CODENODE_WIN_CERT_PASSWORD`。
- 开发机自签名：`node scripts/release-sign.cjs --self-signed`（自签证书默认不可信，需要 `--trust-dev-cert` 才会导入信任链）。
- **未签名的 Windows 便携包会被安全软件误判甚至篡改 PE 主体**（表现为"不是有效的 Win32 应用程序"）。
  分发前必须确认 `release/manifest.json` 里的哈希与实际文件一致。

## 5. 发布模式门禁

`production-gate.yml` 手动触发时可选 `mode=release`：此时会强制校验评测 Key 与签名凭据，
并额外跑真实模型评测（`npm run test:eval:model`，缺 Key 直接非 0 退出）。

```bash
gh workflow run production-gate.yml -f mode=release
```

## 6. 产物归档

- 打包产物：`release/*`（CI 作为 artifact 上传，不入库）
- 评测报告：`docs/eval-reports/*.json|md`（CI 作为 artifact 上传，不入库）
- 发布说明：写明该版本的实际变更与验证；历史 `CHANGELOG.md` 可从 Git 历史查阅，不把当前工作区可能不存在的文件作为唯一入口。

本机交付先在独立 `.stage-*` 目录打包并验收；覆盖前检查旧 `CodeNode.exe` 是否运行，保留未保存的工作。验收通过后替换固定 `release/win-unpacked`，不保留旧包备份。覆盖后再次检查 EXE、`resources/app.asar` 和隔离自检结果，清理暂存及自检数据。源码、测试、配置与文档提交到 `origin/yimi-branch`，生成物按 `.gitignore` 留在本地。
