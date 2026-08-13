# CleanFnOS 兼容升级计划（吸收 fnclearup + fnos-app-cleaner + fnos-logmanager 优点）

> 目标：在 CleanFnOS 现有「应用残留清理」核心上，兼容吸收三个社区工具的成熟功能，
> 同时保留 CleanFnOS 的差异化优势：@appshare 符号链接归属识别（零误报）、token 鉴权（统一网关接入后降级为兜底）、零依赖、iframe 桌面入口。

---

## 一、三个参照工具的功能特性清单

### fnclearup「清理精灵」（Wyf841015/FnDepot，v0.9.2，Node.js ESM 零 npm 依赖，依赖 nodejs_v24）

| 模块 | 功能 |
|---|---|
| 应用残留 | 动态发现所有 vol（/vol1~vol10）+ @app* 目录，交叉比对已安装应用列表识别孤立目录（**有 @appshare 误报缺陷**：share 目录名≠appname） |
| 网盘残余 | 扫描 /vol02/，对比 /etc/mountmgr/mount_info.json 识别已卸载网盘挂载点 |
| Docker 管理 | 卷/网络/镜像扫描在用/未用，一键批量删除；已停止容器清理；Build Cache 清理 |
| tmp 清理 | /tmp 和 /var/tmp 下 24h+ 未访问文件 |
| 文件去重 | SHA-256 哈希比对，4 worker 线程 + streaming hash |
| 音乐去重 | ID3/FLAC 元数据识别重复音乐 |
| 空目录清理 | 扫描空目录，回收站/永久删除，跳过 @app* 系统目录，流式扫描 + state file |
| 系统清理 | 17 项：apt 缓存/列表、syslog/journal、npm/pip/uv/node-gyp/typescript 缓存、4 个浏览器缓存、Playwright、~/.cache、应用日志(>50MB)、旧内核 |
| 回收站批量 | 扫描所有 vol × 所有 UID 的 `.@#local/trash/`，按 mtime 30/90/365 天分级清理 |
| 定时清理 | 5 种类型（应用残余/网盘/Docker/tmp/回收站），可配置时间间隔自动执行 + 清理报告 |
| 大文件查找 | 跨 /vol* 卷 ≥100MB 文件 Top 100 |
| 安全机制 | isSafePath 白名单、删除确认 modal、CSV 注入防护、清理前 manifest 备份、启动警告弹窗 |
| 体验 | 明暗主题、移动端自适应、目录浏览选择器、更新检查 |

### fnos-app-cleaner（zhangyankan，私有 Gitea）

| 模块 | 功能 |
|---|---|
| 链接残留 | 扫描 /usr/local/... 下指向已卸载应用的符号链接 |
| VOL 残留 | /volX/@appstore/、/volX/@appdata/ 等目录下已卸载应用文件夹 |
| 关联系统用户 | 自动匹配残留应用对应的系统账号（支持 docker- 前缀），勾选一并清理 |
| 聚合展示 | VOL 残留按应用名聚合，同应用不同卷的目录合并成卡片，点开看详情 |
| 回收站 | 删除走回收站可撤销，回收站 24h 自动清 |
| KVM 鬼影快照 | 对比 virsh 可见快照 vs qemu-img 实际快照，找隐身快照，一键删除（自动关停 VM 删完恢复） |
| VM 管理 | 启动/关机/强制关机 |
| 自我清理 | 卸载时清干净自己：程序目录/配置/系统用户/链接/回收站/记录 |

### fnos-logmanager「飞牛日志管理」（sushazhi/fnos-logmanager，依赖 fnOS 统一网关 V1.2.0401+）

| 模块 | 功能 |
|---|---|
| 统一网关接入 | 通过 fnOS 统一网关访问，无需独立端口；网关自动校验登录态免密码登录（X-Trim-* Header）；原生 WebSocket 实时通信 |
| 残留清理 | 清理已卸载应用的残留目录（移入系统回收站）；清理已卸载应用的空文件夹 |
| 回收站 | 移入系统回收站而非直接删除，支持还原到原始位置（跨文件系统自动复制+删除），回收站项目 24h 自动清空 |
| 自动清理 | 定时自动清理策略：cron 表达式 + 秒级自定义间隔，按文件大小/天数/正则匹配，独立清理规则管理 |
| 进程管理 | 列出进程（名称/PID/用户/CPU/内存/端口/命令行）、关键字过滤、查看进程打开文件、结束进程（SIGTERM 优雅退出超时 SIGKILL，保护 PID1 与自身） |
| 通知推送 | 23 种通知渠道（Bark/钉钉/飞书/企业微信/Telegram/QQ 机器人等），监控规则关键词匹配、冷却时间与静默时段 |
| 安全 | 路径遍历三重检查、命令注入防护（spawn 数组参数）、SSRF 防护、速率限制、CSRF 时序比较、审计日志 |
| 体验 | 鸿蒙 7.0 液态玻璃设计体系、日间/夜间主题、虚拟滚动（10万+行）、移动端适配 |

---

## 二、CleanFnOS 现状 vs 差距分析

### 已有（保留为底座）
- ✅ @appdata/@appconf/@apphome/@apptemp/@appmeta/@appshare/@appcenter 残留扫描 + 已安装应用交叉比对
- ✅ **@appshare 符号链接归属识别**（/var/apps/{app}/shares + 属主用户双判定，修复 fnclearup 误报）
- ✅ docker- 残留用户识别（全名/去前缀双匹配）
- ✅ 回收站（删除移入回收站可恢复，manifest.json 记录原始路径）
- ✅ token 鉴权（timingSafeEqual 恒时比较）+ iframe 桌面入口
- ✅ 原生 Web UI（HTML/JS/CSS 零依赖）

### 差距（需从三个工具吸收）
| # | 缺失功能 | 来源 | 优先级 |
|---|---|---|---|
| 1 | /usr/local 链接残留清理 | fnos-app-cleaner | P0 |
| 2 | 残留按应用聚合卡片展示（多卷合并） | fnos-app-cleaner | P0 |
| 3 | 危险操作风险分级 + 二次确认 + manifest 备份 | fnclearup | P0 |
| 4 | 卸载时自我清理干净 | fnos-app-cleaner | P0 |
| 5 | 网盘挂载残余（mount_info.json 对比） | fnclearup | P1 |
| 6 | Docker 清理（容器/卷/网络/镜像/BuildCache） | fnclearup | P1 |
| 7 | tmp 清理（24h+ 未访问） | fnclearup | P1 |
| 8 | 回收站批量清理（.@#local/trash 按 mtime 分级） | fnclearup | P1 |
| 9 | 空目录清理 | fnclearup | P1 |
| 10 | 文件去重（SHA-256） | fnclearup | P2 |
| 11 | 音乐去重（ID3/FLAC） | fnclearup | P2 |
| 12 | 大文件查找器（≥100MB Top100） | fnclearup | P2 |
| 13 | 系统清理 17 项 | fnclearup | P2 |
| 14 | 定时清理计划 + 报告 | fnclearup | P2 |
| 15 | KVM 鬼影快照 + VM 管理 | fnos-app-cleaner | P3 |
| 16 | 明暗主题 / 移动端自适应 | fnclearup | P3 |
| 17 | 统一网关接入（X-Trim-* 登录态免 token） | fnos-logmanager | P1 |
| 18 | 通知推送（Bark/钉钉/飞书/企业微信等，配合定时清理报告） | fnos-logmanager | P3 |

---

## 三、兼容设计（模块划分）

保持零依赖 Node.js 架构，**server.js 拆分为路由 + api 模块**（仿 fnclearup 的 ui/api/ 结构，但保留我们的鉴权与安全层）：

```
app/ui/
├── server.js          # 路由 + 统一鉴权 + 静态文件（现有，扩展路由）
├── api/
│   ├── app.js         # 应用残留（现有 scanOrphanDirs 迁入，+ 链接残留 + 聚合卡片）
│   ├── users.js       # docker- 用户残留（现有迁入）
│   ├── netdisk.js     # 网盘挂载残余（新增）
│   ├── docker.js      # Docker 卷/网络/镜像/容器/BuildCache（新增）
│   ├── tmp.js         # tmp 清理（新增）
│   ├── trash.js       # 应用回收站 + .@#local/trash 批量（现有 + 扩展）
│   ├── empty.js       # 空目录清理（新增）
│   ├── dup.js         # 文件/音乐去重（新增，P2）
│   ├── bigfiles.js    # 大文件查找（新增，P2）
│   ├── sysclean.js    # 系统清理 17 项（新增，P2）
│   ├── schedule.js    # 定时清理（新增，P2）
│   └── kvm.js         # 鬼影快照 + VM 管理（新增，P3）
├── index.html         # Tab 化（应用/网盘/Docker/tmp/去重/去空/系统/回收站/大文件）
├── main.js            # 前端逻辑扩展
└── styles.css         # + 明暗主题
```

### 安全设计（贯穿所有模块）
1. **统一鉴权**：现有 token（X-Auth-Token）保持不变，所有 /api/* 强制校验
2. **路径白名单**：isSafeAppPath 扩展为可配置前缀集（/vol*/@app*、/usr/local 链接、/tmp、/var/tmp、/vol*/UID/.@#local/trash），拒绝符号链接、拒绝越界路径
3. **风险分级**：低（apt/npm 缓存等 100% 安全）/ 中 / 高（应用残留目录/用户删除），高风险项强制二次确认弹窗
4. **manifest 备份**：清理前把操作清单写 JSON 到数据目录，支持回看（fnclearup 优点）
5. **删除默认走回收站**，永久删除需显式选择 + 确认（保持现有行为）
6. **@appshare 归属识别不回归**：新增模块一律沿用符号链接+属主用户判定

### 实施顺序（里程碑）
- **M1 v1.1.0（P0）**：server.js 拆分 + 链接残留扫描 + 应用聚合卡片 + 风险分级/确认/manifest 备份 + 卸载自我清理 + 前后端重构为 Tab 骨架 ✅ 已完成（本机实测通过）
- **M2 v1.2.0（P1）**：网盘残余 + Docker 清理 + tmp 清理 + 回收站批量（.@#local/trash mtime 分级）+ 空目录清理 + 统一网关接入（X-Trim-* 登录态，token 降级为兜底）
- **M3 v1.3.0（P2）**：文件去重 + 音乐去重 + 大文件查找 + 系统清理 17 项 + 定时清理计划
- **M4 v1.4.0（P3）**：KVM 鬼影快照 + VM 管理 + 明暗主题 + 移动端适配
- **M5 v1.5.0（P3）**：通知推送（Bark/钉钉/飞书/企业微信等，配合定时清理报告，参考 fnos-logmanager 渠道模型）
- 每个里程碑：fnpack build → 本机安装实测（扫描准确性对照 fnclearup 实测清单：28 残留/0 误报不回归）→ 提交记录

### 不采纳项（明确不做）
- fnclearup 的「更新检查」：不依赖外部服务，避免隐私/不可用问题
- fnclearup 回收站放系统盘的实现：我们回收站放 $TRIM_PKGVAR（应用数据卷），避免撑爆系统盘（论坛实测 bug）
- fnclearup 的启动警告弹窗倒计时：与桌面 iframe 体验冲突，改为清理确认弹窗
- fnos-logmanager 的 23 渠道全量通知：仅吸收常用渠道（Bark/钉钉/飞书/企业微信/Telegram），其余不做
- fnos-logmanager 的日志查看/书签/导出/进程管理：超出清理工具定位，不做
- fnos-logmanager 依赖 fnOS V1.2.0401+ 统一网关：我们保留独立端口 + token 兜底，网关可用时优先，不可用时自动降级

---

## 四、验证基线（不回归）

每次里程碑实测对照：
1. 应用残留：本机 28 个真实残留全部识别，@appshare 0 误报（GooFish/angemedia/generated/logs/uploads 不报）
2. docker- 用户：docker-metube 报、docker-idphotos 不报
3. 回收站：移入→恢复→清空全链路
4. 鉴权：无 token 401 / 有 token 200
5. 桌面入口：iframe 窗口打开正常
