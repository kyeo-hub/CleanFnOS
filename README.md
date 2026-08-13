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
fnpack build -d cleanfnos
# 产物：cleanfnos.fpk
```

## 使用说明

- **Tab 导航**：残留扫描 / 网盘 / Docker / tmp / 回收站 / 系统回收站 / 空目录 / 去重 / 大文件 / 系统清理 / 定时清理 / KVM / 通知，共 13 个面板
- **清理流程**：扫描 → 勾选 → 确认（危险操作需勾选知晓）→ 移入回收站（可恢复）或永久删除
- **修改密码**：右上角「🔑 改密码」，需输入当前密码
- **明暗主题**：右上角「🌓 主题」，localStorage 持久化
- **定时清理**：定时清理页配置启用类型与间隔，执行报告在页面底部列表查看
- **通知**：通知页配置各渠道（Key 或完整 Webhook URL 均可），勾选「定时清理完成后推送报告」后自动推送

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
