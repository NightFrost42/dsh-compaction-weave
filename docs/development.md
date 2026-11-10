# 开发与发布

[简体中文](development.md) · [English](en/development.md)

## 环境

- Node.js 24.9+ 与 npm。
- 宿主集成测试使用 DSH `0.2.2-rc.1` 的运行依赖。
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

这会运行全部离线套件，再运行真实 DSH `Session`、消息表、容量、主动压缩和多代缓存保留测试。模型输出由测试提供，每个进程使用独立的临时存储。

## 目录

```text
lib/               插件运行代码
locale/            中英文插件描述
test/              回归测试与样本
  fixtures/        语义与来源样本
  integration/     DSH 宿主集成测试
  helpers/         测试隔离入口
scripts/           测试、检查与打包工具
docs/              配置、架构、测试与发布文档
cordis.patch.yml   DSH 插件组合包入口
```

`.local/` 保存本地验证输出，`dist/` 保存生成的交付物，二者已加入 `.gitignore`。

GitHub Actions 在 Windows 与 Linux 上使用 Node.js 24 运行离线测试、项目检查和发布打包。

## 构建交付物

运行 `npm run pack:release`，脚本检查项目后生成：

- `dsh-compaction-weave-<version>.tgz`：DSH 安装包。
- `dsh-compaction-weave-<version>-source.tar.gz`：可单独解压运行测试的源码包。
- `SHA256SUMS.txt`：两个包的 SHA-256。
- `manifest.json`：版本、运行环境、包内容及文件校验清单。

安装包按 `package.json.files` 白名单打包；源码包按脚本中的明确目录清单打包。临时目录、原始会话、历史交付物和本地设置不进入交付物。

## 发布顺序

1. 修改 `package.json` 中的版本、文档里的安装包示例和 `CHANGELOG.md`；诊断版本直接读取包版本。
2. 运行离线测试和宿主集成测试，查看所有失败日志。
3. 运行发布打包，在独立目录解压源码包后再次执行测试。
4. 将源码提交到项目仓库，创建同版本标签，并上传安装包、源码包和校验清单。
5. 如发布到 npm，发布已验证的 tarball：

```bash
npm publish dist/dsh-compaction-weave-0.3.2-rc.1.tgz --tag next --access public
```

当前为候选版本，默认发布标签为 `next`。正式版同时更新版本号和 `publishConfig.tag`。

## 新增语义回归

进度判断的样本应同时包含正确摘要和真实矛盾。例如“不得声称图表已生成”应通过；同一句后面补上“但当前图表已生成”时，应根据原始进度判断冲突。

修改候选解析时运行全部审计和进度套件，并检查 `progress-source-compatibility.mjs`，确保既有原始来源记录仍能恢复。
