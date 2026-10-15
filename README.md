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
2. 等待测试和 Windows x64 打包完成。
3. 在该次 Actions 运行的 **Artifacts** 下载 `LYCO-Browser-Windows-x64` 安装包。
4. 已打 `v*` 标签的构建在工作流通过后自动发布为 **Pre-release**。

**此版本只做 Windows x64 的 GitHub-hosted runner 构建**；未对所有代理节点或真实资金交易做端到端测试。执行真实购买前请再次核对账号、积分、价格及网络环境。

## 产品边界

此项目不是紫鸟、战斧的官方软件，不与其账号或接口互通。前期先复用经许可的开源环境管理方案，构建独立的 LYCO 品牌产品。指纹伪装不保证能避免第三方平台的关联检测、风控或账号限制。

此版本 **未**新增独立的浏览器订阅扣费项；仅复用当前已有的 `proxy_1m` 月卡及积分支付。正式新增浏览器商业套餐、分组协作、云同步等功能需要后续明确计费和安全边界。

## 上游与许可证

- 基础项目：`taills/Mirage-Browser`，上游提交 `d31e14887ae75863693070acead8c624224ad0eb`，**MIT License**。
- 保留 `LICENSE` 中的原始版权/许可说明和上游 git 历史。
- LYCO 的新增适配器代码仅依赖本站现有公开客户端 API，不包含后台管理员令牌或代理面板凭据。
