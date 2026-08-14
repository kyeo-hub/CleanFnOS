# CleanFnOS — 飞牛 fnOS 综合清理工具

零依赖 Node.js 实现的飞牛 fnOS 清理应用。在「应用残留清理」核心之上，综合吸收了社区工具
[fnclearup（清理精灵）](https://github.com/Wyf841015/FnDepot)、fnos-app-cleaner、
[fnos-logmanager](https://github.com/sushazhi/fnos-logmanager) 的成熟功能，并保留差异化优势：
**@appshare 符号链接归属识别（零误报）**、token 鉴权（统一网关兜底）、零依赖、iframe 桌面入口。

## 功能总览

| 模块 | 说明 |
|---|---|
| **应用残留** | @appdata/@appconf/@apphome/@apptemp/@appmeta/@appshare/@appcenter 孤儿目录 + /usr/local 链接残留 + docker- 残留用户；@appshare 按 `/var/apps/{app}/shares` 符号链接+属主用户双判定，杜绝 fnclearup 的误报缺陷 |
| **网盘残余** | /vol02 挂载残余：对比 `/etc/mountmgr/mount_info.json` + `/proc/mounts`，格式校验防误判用户目录 |
| **Docker** | 容器/卷/网络/镜像/BuildCache 扫描与清理，只删已停止容器、未用卷、非系统网络、dangling 镜像 |
| **tmp 清理** | /tmp + /var/tmp 24h+ 未访问普通文件，跳过符号链接/系统目录 |
| **系统回收站** | 所有卷 × 用户目录的 `.@#local/trash/` 扫描（支持嵌套层级），按 mtime 30/90/365 天分级清理 |
| **空目录** | 指定根下完全空目录扫描，跳过 @app*/.@#local/docker/lost+found/符号链接/挂载点 |
| **文件去重** | SHA-256 流式哈希（先按大小分组只哈希同大小文件），音乐模式按 ID3/FLAC 元数据识别 |
| **大文件** | 跨 /vol1~vol10 扫描 ≥100MB 大文件 Top100，默认排除 /vol02 网盘 fuse |
| **系统清理** | apt/npm/pip/uv/node-gyp/typescript/浏览器缓存、syslog/journal、应用日志(>50MB) 等 17 项，三档风险 + 推荐集 |
| **定时清理** | 应用/网盘/Docker/tmp/回收站 5 类型，间隔可配，执行报告落盘可回看 |
| **KVM** | 鬼影快照检测（virsh 可见 vs qemu-img 实际对比）、一键删除（自动关停 VM 恢复）、VM 启停管理 |
| **通知推送** | Bark/钉钉/飞书/企业微信/Telegram/Webhook 6 渠道，SSRF 防护，定时清理完成自动推送报告 |

## 安全设计

- **鉴权**：安装向导设置访问密码（支持修改），`timingSafeEqual` 恒时比较；支持 fnOS 统一网关（X-Trim-Userid，仅信任 loopback，防伪造）
- **回收站**：删除默认移入回收站可恢复（目录条目 + 同级 `.meta.json` 元数据，跨文件系统复制兜底）
- **风险分级**：低（缓存/日志，可重建）/ 中 / 高（应用数据/用户），前端色标展示
- **强确认**：永久删除类操作（清空回收站/Docker/系统清理/系统回收站/鬼影快照）强制勾选「我已知晓此操作不可恢复」才能执行
- **路径白名单**：每个模块独立校验（/volN 范围、@app* 类型、/tmp、.@#local/trash 等），拒绝符号链接与路径穿越
- **命令安全**：docker/virsh/qemu-img 一律参数数组化（spawn/execFile），防命令注入
- **SSRF 防护**：通知 URL 仅允许公网 http(s)，拒绝内网/保留地址/带凭证 URL
- **审计日志**：所有清理操作追加写入数据目录 `operation.log`（时间/类型/数量/结果）
- **manifest 备份**：清理前操作清单写入 `manifests/`，支持回看

## 安装

1. 从 GitHub Releases 下载 `cleanfnos.fpk`（或自行打包）
2. 飞牛应用中心安装，或 CLI：`appcenter-cli install-fpk cleanfnos.fpk -v 1`
3. 安装向导设置**服务端口**（默认 47939）与**访问密码**（必填，4-64 位，两次输入一致）
4. 桌面点击图标打开，输入访问密码进入

## 自行打包

```bash
# 依赖：nodejs_v24（fnOS 商店安装）
fnpack build
# 产物：cleanfnos.fpk
```

## 双架构自动发布

GitHub Actions 已配置双架构自动构建（参考社区商店 conversun 做法）：

```bash
git tag v1.6.0 && git push origin v1.6.0
```

推送 `v*` tag 即自动构建 **x86 + arm64** 两个 fpk 并发布 GitHub Release：
- `cleanfnos_<版本>_x86.fpk`（x86_64）
- `cleanfnos_<版本>_arm.fpk`（aarch64）

也可手动运行 `scripts/build.sh x86|arm` 本地打包（产物在 `dist/`）。

## 使用说明

- **Tab 导航**：残留扫描 / 网盘 / Docker / tmp / 回收站 / 系统回收站 / 空目录 / 去重 / 大文件 / 系统清理 / 定时清理 / KVM / 通知，共 13 个面板
- **清理流程**：扫描 → 勾选 → 确认（危险操作需勾选知晓）→ 移入回收站（可恢复）或永久删除
- **修改密码**：右上角「🔑 改密码」，需输入当前密码
- **明暗主题**：右上角「🌓 主题」，localStorage 持久化
- **定时清理**：定时清理页配置启用类型与间隔，执行报告在页面底部列表查看
- **通知**：通知页配置各渠道（Key 或完整 Webhook URL 均可），勾选「定时清理完成后推送报告」后自动推送
- **名词解释**：侧边栏「📖 名词」按钮，面向非专业用户解释 KVM、鬼影快照、TMP 等术语

## 名词解释（面向非专业用户）

| 名词 | 通俗解释 |
|---|---|
| **KVM** | 飞牛虚拟机功能的核心技术，用它在 NAS 里运行 Windows/Linux 虚拟机（相当于在 NAS 里再开一台电脑） |
| **虚拟机** | 在 NAS 里虚拟出来的一台"电脑"，独立运行操作系统，可随时开机/关机 |
| **快照** | 虚拟机的"后悔药"——某个时间点的完整备份，出问题可一键恢复 |
| **鬼影快照** | 快照删除后残留在磁盘文件里的"隐身"快照——界面看不到但仍占空间，本工具可找出并删除 |
| **应用残留** | 卸载应用后遗留在磁盘上的数据文件（卸载不彻底留下的"尸体"） |
| **孤儿目录** | 找不到所属应用的残留目录（应用已卸载，目录还在） |
| **@appshare** | 应用共享数据目录，多个应用可共用；本工具按符号链接识别归属防误删 |
| **TMP** | 系统临时目录（/tmp 等），程序运行产生的临时文件，超 24h 未用可安全清理 |
| **回收站** | 删除文件的暂存区，误删可恢复，定期清空释放空间 |
| **网盘挂载** | 把网盘/远程存储挂载到 NAS 的一个目录（类似插上移动硬盘） |
| **Build Cache** | Docker 构建镜像时产生的缓存，可自动重建 |
| **Dangling 镜像** | 没标签的悬空 Docker 镜像——旧版本构建后的"孤儿"，占空间无实际用途 |
| **Docker** | 容器技术，把应用连同依赖打包运行，互不影响 |
| **去重 / SHA-256** | 用"文件指纹"比对文件内容，找出完全相同的重复文件删除副本 |
| **ID3 / FLAC** | 音乐文件的元数据标签（歌名/歌手/专辑），音乐去重据此辅助识别 |
| **定时清理** | 按设定时间自动执行清理并生成报告 |
| **风险分级** | 按危险程度分低/中/高：低风险放心清理，高风险需勾选确认 |

## 目录结构

```
app/ui/
├── server.js          # 路由 + 统一鉴权 + 静态文件 + 审计日志
├── index.html         # 13 Tab 前端
├── main.js            # 前端逻辑（确认弹窗/主题/移动端）
├── styles.css         # 明暗主题 + 响应式
└── api/               # 12 个后端模块
    ├── app.js         # 应用残留/链接/用户 + 回收站
    ├── netdisk.js     # 网盘残余
    ├── docker.js      # Docker 清理
    ├── tmp.js         # tmp 清理
    ├── trash.js       # 系统回收站分级
    ├── empty.js       # 空目录
    ├── dup.js         # 文件/音乐去重
    ├── bigfiles.js    # 大文件查找
    ├── sysclean.js    # 系统清理 17 项
    ├── schedule.js    # 定时清理 + 报告
    ├── kvm.js         # 鬼影快照 + VM 管理
    └── notify.js      # 通知推送 6 渠道
```

## 数据目录

- 配置：`$TRIM_PKGETC/config.conf`（端口 + 访问密码）、`schedule.json`、`notify.json`
- 回收站：`$TRIM_PKGVAR/trash/`（条目目录 + `.meta.json`）
- 审计：`$TRIM_PKGVAR/operation.log`
- 备份：`$TRIM_PKGVAR/manifests/`
- 报告：`$TRIM_PKGVAR/schedule_reports/`

## 卸载

应用中心卸载会自动清理自身：停止服务、删除数据/配置/临时目录、/usr/local 链接（工具自己不双标）。

## 版本历史

| 版本 | 内容 |
|---|---|
| v1.1.0 | 基础残留清理 + 链接残留 + 聚合卡片 + 风险分级 + 卸载自我清理 |
| v1.2.0 | 网盘/Docker/tmp/系统回收站/空目录 + 统一网关 |
| v1.3.0 | 文件/音乐去重 + 大文件 + 系统清理 17 项 + 定时清理 |
| v1.4.0 | KVM 鬼影快照 + VM 管理 + 明暗主题 + 移动端适配 |
| v1.5.0 | 通知推送 6 渠道 + 定时报告联动 |

## 致谢

参考与吸收：fnclearup（Wyf841015/FnDepot）、fnos-app-cleaner、fnos-logmanager（sushazhi）。
