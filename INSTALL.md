# 安装指南

从零开始，把 **dsh-photoshop-genfill** 装进 DeepSeek-Harness，并让它真正接管 Photoshop 干活。

如果你只想快速跑起来，看 [快速开始](#快速开始)；遇到问题看 [排障](#排障)。

---

## 1. 你会得到什么

装好之后，Harness 里的 Agent 同时具备两层能力：

**第一层：原生 Photoshop 操作**
通过 `@alisaitteke/photoshop-mcp` 接入约 130 个 `mcp__photoshop__*` 工具——建选区、选主体、加蒙版、建调整图层、曲线/曝光/饱和度、内容识别填充、图层样式、裁切、导出、动作、批量处理等。Agent 修图时优先用这些原生非破坏性操作，而不是一上来就生成新图。

**第二层：图片生成 / 编辑 API**
插件自己提供 `ps_*` 工具和斜杠命令，把「抓取画布区域 → 调兼容 OpenAI 的图片接口 → 以智能对象回填并加蒙版」串成一条流水线。用你自己的 Key，不消耗 Adobe Firefly 额度。

两层共用同一个 Photoshop 实例，可以组合使用。

---

## 2. 前置条件

| 项目 | 要求 | 说明 |
|---|---|---|
| 操作系统 | macOS 或 Windows | macOS 走 AppleScript 自动化，验证最充分 |
| Adobe Photoshop | 2024 或更新 | 本机已安装并能正常启动 |
| Node.js | 22 或更新 | 用于运行 Harness 与 MCP 服务 |
| DeepSeek-Harness | 已安装并可打开 Web GUI | 桌面版即可 |
| 图片 API | 兼容 OpenAI Images 的服务地址 + Key | 用于生成/编辑；只做原生修图可不配 |

macOS 上还需要允许自动化：**系统设置 → 隐私与安全性 → 自动化**，勾选允许 Harness 控制 Adobe Photoshop。

---

## 3. 安装

### 3.1 克隆仓库

```bash
git clone https://github.com/Aliax-LI/dsh-photoshop-genfill.git
```

克隆下来就是插件包本身（`package.json`、`cordis.patch.yml`、`index.js` 都在仓库根目录）。

### 3.2 在 Harness 里安装 bundle

打开 Harness，在对话里让 Agent 执行（或使用插件管理界面）：

```text
plugin_manager install_bundle → target: /你的路径/dsh-photoshop-genfill
```

`target` 指向**克隆下来的仓库根目录**。

安装会做三件事：

1. 把插件链接进当前 profile；
2. 注册 `cordis.patch.yml` 里的两条记录——`photoshop` MCP 连接 + 插件 Host 本体；
3. 启用 Host 工具、斜杠命令和输入框下方面板。

### 3.3 首次启动

第一次启动 MCP 时，`npx` 需要联网下载 `@alisaitteke/photoshop-mcp`，会慢一些，属正常现象。

随后**重启或重新加载 Harness**，让新 bundle 完全生效。

### 3.4 确认装好了

在 Harness 里跑一句：

```text
ps_state
```

预期看到 Photoshop 版本、当前文档尺寸、图层数、以及图片 API 的配置状态。看到这些就说明两层能力都通了。

同时确认 Agent 能列出 `mcp__photoshop__*` 工具（例如 `photoshop_get_state`、`photoshop_select_subject`）。

---

## 4. 在设置里配置生图 / 编辑模型

这是本插件的配置入口：**Harness → Settings → Plugins → Photoshop Retouch Agent**。

插件向 Settings 暴露了原生配置表单，共九个字段：

| 字段 | 作用 | 默认值 |
|---|---|---|
| `apiBaseUrl` | 兼容 OpenAI 的图片服务地址，带不带 `/v1` 都行 | `https://chatgpt2api.343426.xyz/v1` |
| `apiKey` | Bearer Key；留空则读环境变量 `PS_GENFILL_API_KEY` | 空 |
| `model` | 回退模型：下面两个都留空时用它 | `gpt-image-2` |
| `generationModel` | **文生图**模型（`ps_generate_layer`、`ps_generate_images`） | 空 → 回退 `model` |
| `editModel` | **图像编辑**模型（`ps_generative_fill`、`ps_image_edit`） | 空 → 回退 `model` |
| `photoshopApp` | AppleScript 自动化使用的应用名 | `Adobe Photoshop 2026` |
| `outputDir` | 抓取图与生成结果的保存目录 | `~/.dsh/photoshop-genfill` |
| `requestTimeoutMs` | 单次图片请求超时（毫秒，10000–600000） | `180000` |
| `defaultFit` | 结果放入画布的方式：`cover` / `stretch` / `contain` | `cover` |

**生成与编辑分开配置**是这里的重点。很多服务商的文生图和图像编辑使用不同模型名，例如：

```yaml
model: gpt-image-2            # 兜底
generationModel: gpt-image-2  # 文生图
editModel: gpt-image-2-edit   # 图像编辑
```

只填 `model` 时两个端点都用它，行为与旧版一致——所以从旧配置升级不会被破坏。

### 三条配置途径

任选其一，优先级从高到低：

1. **Settings 表单**（推荐）：填完保存，Harness 会持久化，重载后仍在。
2. **环境变量**：`export PS_GENFILL_API_KEY=sk-...`，适合放在 shell profile 或启动脚本里，避免 Key 落到任何文件。
3. **`cordis.patch.yml`**：作为初始默认值。**不要把自己的 Key 提交进 Git**。

### 关于默认 API 地址

`https://chatgpt2api.343426.xyz/v1` 是作者自用的第三方转发服务，仅作示例。你应当替换成自己的服务地址。任何兼容 `/v1/images/generations` 与 `/v1/images/edits` 的服务都可以用。

---

## 5. 验证 API 连通性

配置完成后，用 curl 单独确认 Key 和服务地址没问题（比在 Photoshop 里试错快得多）：

```bash
curl -s -H "Authorization: Bearer $PS_GENFILL_API_KEY" \
  https://你的地址/v1/models | head -c 300
```

返回 200 且带模型列表即通。`401` 是 Key 问题，`404` 多半是 `apiBaseUrl` 写错或路径重复。

---

## 6. 第一次修图

### 方式一：直接对话（推荐）

```text
先 ps_preview 看一下当前画布，然后把这个人的背景换成极简灰棚，
人物和衣服保持完全不变。
```

Agent 会先预览、再判断区域、优先用原生调整图层与蒙版，必要时才调外部 API，最后再预览确认。

### 方式二：斜杠命令

| 命令 | 作用 |
|---|---|
| `/psfill <提示词>` | 生成式填充：抓选区 → 编辑 → 回填并加蒙版 |
| `/psgen <描述>` | 文生图并放入当前文档 |
| `/psedit <要求>` | 图生图 / 局部重绘 |
| `/psstatus` | 查看 PS/文档/选区/图层/API 状态 |
| `/psundo [n]` | 撤销历史步骤 |

### 方式三：输入框下方面板

装上插件后，输入框下方会出现一条紧凑面板，支持「填充 / 生成 / 编辑」三种模式，效果与命令一致，不占模型 token。

---

## 7. 排障

| 现象 | 原因与处理 |
|---|---|
| 看不到 `ps_*` 工具 | bundle 没启用或没重载。检查 Settings → Plugins 里插件是否为启用状态，然后重新加载。 |
| Settings 里没有表单，只有原始配置 | 插件降级运行了（找不到 schema 模块）。不影响功能；重装 bundle 通常可恢复表单。 |
| `ps_state` 报 AppleScript 错误 | Photoshop 没启动，或自动化权限没给。见第 2 节。 |
| `mcp__photoshop__*` 工具不出现 | `npx` 首次下载失败。检查网络与 npm 源；patch 里已固定 `registry.npmjs.org` 规避镜像问题。 |
| `图片 API 鉴权失败（401）` | Key 无效或没被读到。用第 5 节的 curl 排除；确认 Settings 保存成功，或环境变量已导出到 Harness 进程。 |
| `图片 API 超时` | 生成/编辑通常 25–60 秒，偶发更慢。调大 `requestTimeoutMs` 后重试。 |
| `当前没有像素选区` | 用选框/套索建选区，或让 Agent 调 `photoshop_select_subject`。 |
| 生成结果位置/比例不对 | 调整 `defaultFit`（`cover` 铺满、`contain` 完整放入），或先确认选区范围。 |
| 想彻底卸载 | Settings → Plugins 禁用/卸载，或执行 `plugin_manager remove_bundle`。 |

---

## 8. 安全与隐私

- 仓库和 patch 里**不含任何 API Key**。Key 只在你自己机器的 Settings、环境变量或私有 profile 层。
- 图像编辑接口会把捕获的画布区域**发送到你配置的第三方服务**。处理客户图、未发布款式、人像等敏感素材前，请确认对方的隐私政策。
- 只做原生修图（选区、蒙版、调整图层、内容识别）时，画布像素不会离开本机。
- MCP 服务由本机 `npx` 启动，只通过 stdio 与 Harness 通信。
- 插件只写 `outputDir` 和 Photoshop 文档，不改系统设置。

---

## 9. 卸载

```text
plugin_manager remove_bundle → target: @local/dsh-photoshop-genfill
```

这会移除插件和它带进来的 MCP 连接。`outputDir` 里的历史输出不会自动删除，需要的话手动清理。
