# Toonflow 自定义实例 —— 完整源码 + 资产备份

一个自建 Toonflow 实例的**自包含**备份：完整上游源码（含全部修改）+ 运行时资产 + 部署脚本。

> 基线：`HBAI-Ltd/Toonflow-app` @ `30139c9`（MIT License）
> 备份时间：2026-10-25

**特性**：克隆后直接 `bun install && bun run build:server` 即可构建，**不需要再拉上游**。

---

## 目录结构

```
.
├── source-tree/             完整源码树（929 文件，26 MB）
│   ├── apps/                server + web
│   ├── packages/            tools / i18n / startup 等
│   ├── docs/                文档与截图
│   ├── package.json
│   ├── bun.lock
│   ├── Dockerfile
│   └── LICENSE              MIT，Copyright (c) 2026 HBAI-Ltd
├── assets/                  运行时数据资产（38 文件）
│   ├── canvases/            画布节点图
│   ├── providers/           自定义媒体供应商
│   ├── skills/              提示词知识库
│   └── ext/                 扩展注册表
├── patches/                 补丁与部署
│   ├── toonflow-custom.patch    改动 diff（56 KB）
│   ├── source/                  11 个改动文件全文
│   ├── deploy/                  nginx + restore + 监控
│   ├── install.sh               新服务器一键部署
│   └── collect_code.py          资产采集脱敏脚本
├── settings.json            脱敏配置
└── README.md
```

**两种恢复方式**：

| 方式 | 用哪份 | 适合 |
| --- | --- | --- |
| 直接用 `source-tree/` | 已含所有改动 | 推荐，最快 |
| clone 上游 + `git apply patches/toonflow-custom.patch` | 验证补丁是否干净 | 想确认改了什么 |

---

## 一、这个实例做了什么

在原生 Toonflow 上打了 6 处修复，核心是让 Agent 生成的图/视频**自动落到画布**：

| # | 问题 | 改动 |
| --- | --- | --- |
| 1 | Agent 生成的图/视频只落盘，画布空空 | 新增 `apps/web/src/lib/canvasAutoplace.ts` + 改 `conversation.vue` |
| 2 | 视频模型丢参考图，还说"模型不支持" | `packages/tools/mediaGeneration/src/index.ts` |
| 3 | YuxiBox 拒收 base64 图片 | `apps/server/src/utils/media/generation.ts` 的 `readRemoteReference` |
| 4 | 对话报"参数错误" | `apps/server/src/routes/agent.ts` |
| 5 | 画布一直提示"尚未就绪" | `canvasMenu.vue` |
| 6 | 公网访问全 403 | `patches/deploy/nginx.conf` 的 `map` |

**关键设计**：自动上画布是**前端拦截**，不是靠提示词约束模型。只要工具成功返回产物路径，节点就会创建、写入、连线。

---

## 二、快速部署

### 用源码树直接构建

```bash
cd source-tree
docker build -t toonflow:app .
```

> 若 `bun install` 因容器 DNS 失败，用 `docker build --network=host -t toonflow:app .`

### 或一键脚本（含 nginx + 监控）

```bash
cd patches
MACHINE_DOMAIN=你的机器id bash install.sh
```

### 恢复画布数据

```bash
cp -r assets/* /data/home/toonflow/data/
# canvases/canvas-1.json 需改回原名「画布1.json」
```

### 验证

```bash
docker exec toonflow sh -c "grep -c findCanvasNodes /app/build/web/assets/workspace-*.js | head -1"
docker exec toonflow sh -c "grep -c addNode /app/build/tools/mediaGeneration.tool.js"
docker exec toonflow sh -c "stat -c %s /app/build/server/index.js"   # 约 23MB
```

---

## 三、敏感信息

已确认**不含**：API key / token / 密码、服务器 IP、机器 ID、域名、Agent 对话记录、生成的媒体文件、用户名邮箱。

`settings.json` 已剔除 `apiKey` 字段。全仓库 988 个文件扫描 6 类凭证，**0 命中**。

`.gitignore` 双重保险：媒体规则只作用于 `assets/`（运行时），不会误伤 `source-tree/` 里的 logo、UI 资源和文档截图。

---

## 四、未备份的内容

| 内容 | 大小 | 原因 |
| --- | --- | --- |
| `workspaces/assets/` | 99 MB | 生成的图片视频，二进制大文件 |
| `workspaces/.agent/` | 48 MB | Agent 对话日志，含隐私 |
| `ffmpeg/` | 153 MB | 可下载的二进制 |
| `node_modules/` | 1.4 GB | 容器内，`bun install` 重建 |
| `build/` | 98 MB | 编译产物 |
| `nodes/ tools/ ext/*.umd.js` | 5.4 MB | 编译产物 |

**注意**：画布 JSON 只存 `assets/<节点id>/<文件>.png` 相对引用。恢复后节点和连线都在，但**图片需另外拷贝 `workspaces/assets/`**。

---

## 五、踩过的坑

### `/app` 不是 bind mount

容器里**只有 `/app/data`** 挂载自宿主机。改源码必须 `docker cp` 或构建时 `COPY`。

### 构建入口只有一个

```bash
bun run build:server   # ✅ 正确
bun run build          # ❌ ENOENT 失败
bun build src/index.ts # ❌ 会把 23MB 压成 1.8KB 空壳
```

### `docker commit` 会攒冗余镜像

每次生成 3.5GB 新镜像（共享层级，各多占约 130MB）。事后清理：

```bash
docker images -f dangling=true -q | xargs -r docker rmi -f
docker system df   # Reclaimable 应为 0
```

### nginx 403 是两层原因

网关把 `Host` 改写成 `127.0.0.1:3000`（真域名在 `X-Forwarded-Host`），且浏览器同源 GET 不带 `Origin`、网关又设 `no-referrer`。`map` 同时解决。

---

## 六、许可

上游 MIT License，`Copyright (c) 2026 HBAI-Ltd`，`LICENSE` 文件已保留在 `source-tree/`。

修改再分发需保留原版权声明。本仓库的改动部分同样适用 MIT。
