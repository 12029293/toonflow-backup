# Toonflow 自定义实例 —— 资产与补丁备份

一个自建 Toonflow 实例的完整可还原备份：**画布数据资产** + **源码补丁** + **部署脚本**。

> 基线：`HBAI-Ltd/Toonflow-app` @ `30139c9`（MIT License）
> 备份时间：2026-10-25

---

## 目录结构

```
.
├── assets/                  画布数据资产（不含媒体文件）
│   ├── canvases/            画布节点图
│   ├── providers/           自定义媒体供应商源码
│   ├── skills/              提示词知识库
│   └── ext/                 扩展注册表
├── patches/                 源码补丁与部署
│   ├── toonflow-custom.patch    全部改动的 git 补丁
│   ├── source/                  改动文件全文（补丁失败时用）
│   ├── deploy/                  nginx + 部署脚本 + 监控
│   ├── install.sh               新服务器一键部署
│   └── collect_code.py          资产采集脚本（脱敏）
├── settings.json            脱敏后的应用配置
└── README.md
```

---

## 一、这个实例做了什么

在原生 Toonflow 上打了 6 处修复，核心是让 Agent 生成的图/视频**自动落到画布**：

| # | 问题 | 改动位置 |
| --- | --- | --- |
| 1 | Agent 生成的图/视频只落盘，画布空空 | `patches/source/.../canvasAutoplace.ts`（新增）+ `conversation.vue` |
| 2 | 视频模型丢参考图，还说"模型不支持" | `patches/source/.../mediaGeneration/src/index.ts` |
| 3 | YuxiBox 拒收 base64 图片 | `patches/source/.../media/generation.ts` |
| 4 | 对话报"参数错误" | `patches/source/.../routes/agent.ts` |
| 5 | 画布一直提示"尚未就绪" | `patches/source/.../canvasMenu.vue` |
| 6 | 公网访问全 403 | `patches/deploy/nginx.conf` |

**关键设计**：自动上画布是**前端拦截**，不是靠提示词约束模型。只要工具成功返回产物路径，节点就会创建、写入、连线。

---

## 二、assets/ 说明

### canvases/canvas-1.json

画布持久化文件，包含节点类型、位置、提示词、模型参数、连线关系。

产物以 `assets/<节点id>/<文件id>.png` **相对路径**记录——这里只存引用，**不含图片本身**。

### providers/

| 文件 | 说明 |
| --- | --- |
| `yuxibox.ts` | MiniMax H3 视频 + GPT Image 2.5，需 `requiresRemoteMedia: true`（不接受 base64）|
| `yingce.ts` | 北辰/Yingce，OpenAI 兼容协议，支持视频轮询 |

**不含密钥**，密钥在运行时配置。

### skills/

三套提示词工作流：`canvas/`（画布操作）、`v118workflow/`（短剧生产全流程）、`workflow/`（通用创作）。纯 markdown，是 Agent 的专业知识来源。

---

## 三、部署到新服务器

### 最简方式

```bash
# 1. 上传整个仓库到新机器
cd /path/to/repo/patches

# 2. 一键部署（换成新机器的 machine id）
MACHINE_DOMAIN=新机器id bash install.sh
```

脚本会自动：克隆上游 → 钉住 `30139c9` → 打补丁 → 构建镜像 → 启动容器 → 配 nginx → 装监控。

首次构建 5–10 分钟。

### 恢复画布数据

```bash
# 把 assets/ 内容放回数据目录
cp -r assets/* /data/home/toonflow/data/
# 注意 canvases/canvas-1.json 要改回原名「画布1.json」
```

### 验证

```bash
docker exec toonflow sh -c "grep -c findCanvasNodes /app/build/web/assets/workspace-*.js | head -1"
docker exec toonflow sh -c "grep -c addNode /app/build/tools/mediaGeneration.tool.js"
docker exec toonflow sh -c "stat -c %s /app/build/server/index.js"   # 应约 23MB
```

---

## 四、敏感信息处理

已确认**不含**：

- ❌ API key / token / 密码
- ❌ 服务器 IP、机器 ID、域名
- ❌ Agent 对话记录
- ❌ 生成的图片/视频
- ❌ 用户名、邮箱

`settings.json` 已剔除 `apiKey` 字段。最终扫描 9 类凭证模式，**0 命中**。

保留 `anonymousId`（随机 UUID，用于匿名统计），介意可删。

---

## 五、未备份的内容

| 内容 | 大小 | 原因 |
| --- | --- | --- |
| `workspaces/assets/` | 99 MB | 生成的媒体，二进制大文件 |
| `workspaces/.agent/` | 48 MB | 对话日志 |
| `ffmpeg/` | 153 MB | 可重新下载 |
| `nodes/ tools/ ext/*.umd.js` | 5.4 MB | 编译产物，构建时生成 |

需要备份媒体文件建议用对象存储或 `git-lfs`。

---

## 六、踩过的坑

### `/app` 不是 bind mount

容器里**只有 `/app/data`** 挂载自宿主机。改源码必须 `docker cp` 或构建时 `COPY`。

### 构建入口只有一个

```bash
bun run build:server   # ✅ 正确
bun run build          # ❌ ENOENT 失败
bun build src/index.ts # ❌ 会把 23MB 压成 1.8KB 空壳
```

### `docker commit` 会攒冗余镜像

每次生成 3.5GB 新镜像（共享层级，每个多占约 130MB）。commit 后清理：

```bash
docker images -f dangling=true -q | xargs -r docker rmi -f
docker system df   # Reclaimable 应为 0
```

### `bun install` 可能因网络失败

```bash
docker build --network=host -t toonflow:app .   # 规避容器 DNS 问题
```

### nginx 403 是两层原因

网关改写 `Host` 到 `127.0.0.1:3000`（真域名在 `X-Forwarded-Host`），且浏览器同源 GET 不带 `Origin`、网关又设 `no-referrer`。`nginx.conf` 里的 `map` 同时解决。

---

## 七、许可

上游 MIT License，`Copyright (c) 2026 HBAI-Ltd`。修改再分发需**保留原版权声明**。

本仓库的 `patches/` 是基于上游的衍生作品，同样适用 MIT。
