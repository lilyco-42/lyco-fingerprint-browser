# LYCO Browser (early preview)

基于开源 [Mirage Browser](https://github.com/taills/Mirage-Browser) 的多环境浏览器管理客户端，结合已有的 LYCO 代理订阅与 Billing 账号体系。

> **构建与自动化测试仅在 GitHub Actions 上运行。** 本地目录只用于源码编辑和 git 提交；请勿在本地执行 `npm install`、`npm test`、`npm run start`、`npm run make` 或打包。

## 已接入

- 独立 Chromium Profile、代理源及 Mihomo 节点管理（源自 Mirage）
- LYCO 账号登录：`POST https://lain42.top/studio/api/login`
- 读取积分和代理权益：`GET /studio/api/me`
- 通过服务端产品目录读取最新 `proxy_1m` 积分价格
- 显式确认后调用 `POST /studio/api/points/purchase` 购买代理月卡（保留跨重试幂等编号）
- 在默认浏览器打开官方充值收银台，不在桌面端收集第三方付款凭证
- 从已激活代理权益中导入个人专属 Clash/Mihomo 订阅，用户自行绑定浏览器环境
- 登录令牌在 Electron 主进程管理；支持系统安全存储时加密持久化，否则仅保留进程内状态

## 如何获取安装包

1. 打开本仓库的 **Actions → LYCO Browser CI & Windows Installer**，选择 **Run workflow**（或查看 `main` push 触发的执行）。
2. 工作流先在标准 Ubuntu runner 执行单元、类型和真实 Chromium 启动检查，通过后才在标准 Windows runner 构建。
3. Windows 再运行单元检查、实际便携包的界面／本地 IPC 冒烟，以及实际 Setup 的安装、已安装界面、图标／快捷方式和卸载检查。成功后把 `.exe`、`.zip`、同名校验值与测试结果保存到 `preview-<run-id>-<attempt>` **未发布草稿**。草稿仅仓库维护者可下载审查，不占用 Actions Artifact 存储。
4. `main`、PR 与手动构建共用门禁；不自动把预览草稿发布给用户。历史 `ci-2` 是旧版本，不包含后续修复。

**此版本只做 Windows x64 的 GitHub-hosted runner 构建**；未对所有代理节点或真实资金交易做端到端测试。执行真实购买前请再次核对账号、积分、价格及网络环境。

标准 GitHub 托管 runner 在公开仓库使用；本项目不使用收费 larger runner，也不依赖私人 Radxa 或韩国服务器。构建号可在上述 Actions 执行详情查看。Windows 临时 VM 的检查不等于用户本机、所有浏览器会话或第三方平台的完整验收。

## 产品边界

此项目不是紫鸟、战斧的官方软件，不与其账号或接口互通。前期先复用经许可的开源环境管理方案，构建独立的 LYCO 品牌产品。指纹伪装不保证能避免第三方平台的关联检测、风控或账号限制。

此版本 **未**新增独立的浏览器订阅扣费项；仅复用当前已有的 `proxy_1m` 月卡及积分支付。正式新增浏览器商业套餐、分组协作、云同步等功能需要后续明确计费和安全边界。

## 上游与许可证

- 基础项目：`taills/Mirage-Browser`，上游提交 `d31e14887ae75863693070acead8c624224ad0eb`，**MIT License**。
- 保留 `LICENSE` 中的原始版权/许可说明和上游 git 历史。
- LYCO 的新增适配器代码仅依赖本站现有公开客户端 API，不包含后台管理员令牌或代理面板凭据。
- 第三方组件与运行数据边界见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 和 [SECURITY.md](SECURITY.md)。不要上传用户 Profile、Cookie、订阅链接或环境导出包。
