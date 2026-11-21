# 开发与发布

[简体中文](development.md) · [English](en/development.md)

## 环境

- Node.js 24.9+ 与 npm。
- 插件兼容声明为 DSH `>=0.2.2-rc.1 <1.0.0-0`（覆盖 `0.2.x–0.x`）；宿主集成测试使用已实测 DSH 宿主版本（`0.2.2-rc.1`、`0.2.2-rc.2` 或 `0.2.2-rc.3`）的运行依赖。
- 源码使用 JavaScript ES modules，没有构建步骤或额外运行依赖。

## 常用命令

```bash
npm test
npm run check
npm run pack:release
```

`npm test` 自动发现 `test/` 的测试套件，用独立进程和临时 `DSH_HOME` 执行。单个套件有时间上限，失败日志和汇总保存在 `.local/test-results/`。

`npm run check` 检查 JavaScript 语法、JSON、包入口、文档链接、发布版本和发布文件中的敏感信息模式。

### 宿主集成测试

把 `DSH_TEST_NODE_MODULES` 指向 DSH 安装目录中的 `node_modules`：

```powershell
$env:DSH_TEST_NODE_MODULES = 'D:/Apps/DSH/node_modules'
npm run test:host
```

也可以直接提供目录参数：

```bash
node scripts/test.mjs --host-modules /path/to/dsh/node_modules
```

这会运行全部离线套件（数量随当前版本变化），再运行真实 DSH `Session`、消息表、容量、主动压缩、多代缓存保留，以及兼容范围准入、原生持久化提交、回滚、决定后异常、冷恢复、批量 `append` 和未知方法拒绝测试（见当前测试记录）。模型输出由测试提供，不调用付费模型，每个进程使用独立的临时存储。宿主兼容与测试记录见 [rc3-host-compatibility.json](benchmarks/rc3-host-compatibility.json)。

## 目录

```text
lib/               插件运行代码
locale/            中英文插件描述
test/              活动回归测试与样本
  integration/     DSH 宿主集成测试
  helpers/         测试隔离入口
  archived-regex/  已归档的旧正则与合成词表测试（退出默认运行）
scripts/           测试、检查与打包工具
docs/              配置、架构、测试与发布文档
cordis.patch.yml   DSH 插件组合包入口
```

`.local/` 保存本地验证输出，`dist/` 保存生成的交付物，二者已加入 `.gitignore`。

GitHub Actions 在 Windows 与 Linux 上使用 Node.js 24 运行离线测试、项目检查、发布打包，以及针对 DSH `0.2.2-rc.1` 与 `0.2.2-rc.3` 的隔离宿主测试矩阵。

## 构建交付物

运行 `npm run pack:release`，脚本检查项目后生成：

- `dsh-compaction-weave.tgz`：无版本号的稳定最新包副本（与下方带版本号 `.tgz` 内容一致，供 `releases/latest/download/dsh-compaction-weave.tgz` 固定链接下载）。
- `dsh-compaction-weave-<version>.tgz`：带版本号的 DSH 安装包。
- `dsh-compaction-weave-<version>-source.tar.gz`：可单独解压运行测试的源码包。
- `SHA256SUMS.txt`：三个归档产物的 SHA-256。
- `manifest.json`：版本、运行环境、包内容及文件校验清单。

安装包按 `package.json.files` 白名单打包；源码包按脚本中的明确目录清单打包。临时目录、原始会话、历史交付物和本地设置不进入交付物。

## 发布顺序

1. 修改 `package.json` 中的版本、文档里的安装包示例和 `CHANGELOG.md`；诊断版本直接读取包版本。
2. 运行离线测试和宿主集成测试，查看所有失败日志。
3. 运行发布打包，在独立目录解压源码包后再次执行测试。
4. 将源码提交到项目仓库，创建同版本标签，并上传安装包、源码包和校验清单。
5. 如发布到 npm，发布已验证的 tarball：

```bash
npm publish dist/dsh-compaction-weave-0.3.3.tgz --tag latest --access public
```

正式版默认发布标签为 `latest`（如需发布预览候选版，则改用预发布版本号并将 `publishConfig.tag` 设为 `next`）。

## 新增语义回归

进度判断目前以显式 `key: value` 结构化事实为准，样本应同时包含正确摘要和真实矛盾。例如保留 `chartGenerated: false` 与正确 `seq=` 历史引述应通过；把同作用域最新值改写为 `chartGenerated: true` 或 `null` 时，应能触发 `PROGRESS_FACT_CONFLICT`。

修改候选解析、通道隔离或审计逻辑时，请运行全部活动测试（重点检查 `phase1-optimizations.mjs`、`phase2-optimizations.mjs`、`phase3-route-b.mjs`、`astra-review-fixes.mjs`、`release-billing-safety.mjs` 与 `constraint-scope.mjs`），确保版本 1 / 版本 2 结构化进度来源、计费边界及归档兼容契约不受影响。
