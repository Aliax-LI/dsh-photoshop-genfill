# Photoshop 生成式填充插件（dsh-photoshop-genfill）

一个 DeepSeek Harness 的 profile 插件包，把 **Photoshop 操作** 和 **图片生成 / 图片编辑 API** 接在一起：

- 基于 `@alisaitteke/photoshop-mcp`（MCP stdio 连接，128 个 `photoshop_*` 工具）让 Agent 直接操作 Photoshop；
- 工具结果里的画布预览会写入 Harness 附件存储并作为图片内容返回给模型/UI；独立 `ps_preview` 和生成/编辑/放置/撤销工具均支持该闭环；
- 输入框下方提供一个紧凑面板（`/psfill`、`/psgen`、`/psedit`、`/psstatus`、`/psundo`），也可以直接用斜杠命令或让 Agent 调用工具。

目标场景：不想消耗 Adobe Firefly 生成额度，用自己/第三方兼容 OpenAI 图片接口（本插件默认 `https://chatgpt2api.343426.xyz/v1`，模型 `gpt-image-2`）完成「图层生成式填充」。

---

## 1. 能力

| 能力 | Agent 工具 | 斜杠命令 | 面板 |
|---|---|---|---|
| 生成式填充（抓选区 → 编辑 → 写回蒙版图层） | `ps_generative_fill` | `/psfill <提示词>` | 「填充」模式 |
| 文生图并放入当前文档（适配画布） | `ps_generate_layer` | `/psgen <描述>` | 「生成」模式 |
| 图生图 / 局部重绘（整幅或选区） | `ps_image_edit` | `/psedit <要求>` | 「编辑」模式 |
| 只出图不入 PS（先看几张再选用） | `ps_generate_images` | – | – |
| 把本地图片放进当前文档 | `ps_place_image` | – | – |
| 查看当前合成画布的图像预览（返回图片内容，不只是路径） | `ps_preview` | – | – |
| 查看 PS/文档/选区/图层/API 配置 | `ps_state` | `/psstatus` | 状态按钮 |
| 撤销历史步骤 | `ps_undo` | `/psundo [n]` | 撤销按钮 |

同时，MCP 连接把 `photoshop-mcp` 的 128 个工具注册为 `mcp__photoshop__*`（如 `mcp__photoshop__photoshop_select_subject`、`mcp__photoshop__photoshop_select_rectangle`、`mcp__photoshop__photoshop_get_state`、`mcp__photoshop__photoshop_recipe_remove_background` 等），用于建选区、调图层、导出、批处理等精细操作；本插件负责把「图片生成 API + 图层回填」这一段串起来。

### 修图 Agent 工作流

- 先调用 `ps_preview` 看当前画布，再结合 `ps_state`、图层/选区信息判断目标与保留内容；
- 优先使用 Photoshop 原生非破坏性工具、调整图层、蒙版和 recipe；只有需要大范围重绘或用户明确要求时才用外部图像 API；
- 每次关键修改后工具会返回最新合成画布图像，Agent 应检查结果是否符合要求；不符合时使用撤销并缩小范围/降低强度后重试；
- 保存/导出前再次预览并结构检查。这里的画布预览是按需快照，不是 Photoshop UXP 提供的逐帧实时镜像。

```
1. 在 Photoshop 里打开一张图，用选框工具圈出区域（或对 Agent 说“选中主体”）
2. /psfill 赛博朋克夜景，霓虹灯，电影感
   → 抓取选区 → gpt-image-2 编辑接口 → 以「AI Fill …」新图层回填，并按选区加蒙版
3. /psundo 1 可回退；/psstatus 查看文档/选区/图层状态
```

对 Agent 的自然语言示例：

- 「用生成式填充把选区改成赛博朋克夜景，保留构图」
- 「选中这个人物，把他换成穿宇航服的样子」
- 「生成一张极简产品海报放到当前文档，做成新图层」
- 「把整个画布调成暖色电影感，先给我三张图看看」→ 会先 `ps_generate_images`，再 `ps_place_image`

---

## 2. 安装

### 从 GitHub 安装

1. 安装 DeepSeek Harness、Node.js 22+、Adobe Photoshop 2024+，并确保 Photoshop 可以被本机自动化控制。
2. 克隆仓库：

```bash
git clone https://github.com/<你的账号>/dsh-photoshop-genfill.git
cd dsh-photoshop-genfill
```

3. 在 Harness 中执行 `plugin_manager install_bundle`，将 `target` 指向克隆下来的仓库目录：

```text
<仓库目录>
```

4. 在 Harness Settings → Plugins 中启用 `Photoshop Retouch Agent`，填写 API 地址、Key 和模型。
5. 重启或重新加载 Harness；首次启动 MCP 时允许 Harness 控制 Photoshop。

### 从本地目录安装

```text
plugin_manager install_bundle → target: /path/to/dsh-photoshop-genfill
```

安装会同时启用 `photoshop-mcp` 和本插件的 Host 工具、命令与 Web 面板。

依赖与前提：

- macOS 或 Windows + Adobe Photoshop；
- Node.js 22+，首次启动 MCP 需要网络以下载 `@alisaitteke/photoshop-mcp`；
- 兼容 OpenAI Images API 的服务地址和 API Key；
- 不要把真实 API Key 写入 Git，优先使用 Harness Settings 或环境变量 `PS_GENFILL_API_KEY`。

---

## 3. 配置

配置写在 bundle 的 `cordis.patch.yml` 里作为初始值；安装后请在 **Harness Settings → Plugins → Photoshop Retouch Agent** 中修改。改完重载插件或重启 Harness 生效。

```yaml
- id: photoshop-genfill
  name: '@local/dsh-photoshop-genfill'
  config:
    apiBaseUrl: 'https://your-image-api.example/v1'
    apiKey: ''                         # 建议在 Settings 填写，或使用 PS_GENFILL_API_KEY
    model: 'gpt-image-2'               # 旧配置兼容回退值
    generationModel: 'gpt-image-2'     # ps_generate_layer / ps_generate_images
    editModel: 'gpt-image-2'            # ps_generative_fill / ps_image_edit
    photoshopApp: 'Adobe Photoshop 2026'
    outputDir: '~/.dsh/photoshop-genfill'
    requestTimeoutMs: 180000
    defaultFit: 'cover'
```

`generationModel` 和 `editModel` 可以填写不同模型。例如文生图使用 `gpt-image-2`，图像编辑使用服务商提供的 `gpt-image-2-edit`。如果只填写旧字段 `model`，两个端点都会回退到它。

说明：

- `apiBaseUrl` 支持带或不带 `/v1`；接口路径固定为 `POST /v1/images/generations`、`POST /v1/images/edits`。
- `apiKey` 不要提交到 GitHub；可以在插件 Settings 填写，也可以设置环境变量 `PS_GENFILL_API_KEY`。
- 图片接口返回 `{"error":{"message":…}}` 时会转成可读错误。
- 所有生成物落在 `outputDir`：`capture-*.png`、`gen-*.png`、`edit-*.png`。

---

## 4. 面板与命令

安装后，Web GUI 输入框下方出现一条紧凑面板：

```
● PS 生成式填充   [模式 ▾]  [提示词…]                    [生成]  [状态] [撤销]
```

- 模式：填充（选区）/ 生成（新图层）/ 编辑（图生图）；
- 提交后通过 Harness 的 Client Remote 执行对应全局命令，结果同时出现在对话里的命令记录行；
- 面板只做触发与状态展示，真正的流水线在 Host 端执行（不占模型 token）。

命令输出示例：

```
✅ 生成式填充
已生成并写入图层「AI Fill 16:21:03 cyberpunk」（选区 620×480px，已按选区加蒙版）。
图层: AI Fill 16:21:03 cyberpunk
文档: poster.psd (1920×1080px)
区域: selection 620×480px @ (100,50)，已加选区蒙版
图片 API: gpt-image-2 / 27.3s
输出: edit-<timestamp>.png
```

---

## 5. 实现结构

```
.
├── package.json          # bundle 清单：dsh.bundle.patch + dsh.client
├── cordis.patch.yml      # MCP 连接行 + Host 插件行（含配置）
├── index.js              # Host：Config schema、工具注册、斜杠命令注册
├── lib/
│   ├── ps-bridge.js      # macOS：AppleScript → Photoshop ExtendScript，串行队列/超时/错误
│   ├── ps-scripts.js     # ExtendScript 片段：读状态/抓选区/放置图层/加蒙版/撤销
│   ├── image-api.js      # 兼容 OpenAI 的 images/generations + images/edits 客户端
│   └── pipeline.js       # 抓取 → 调 API → 回填 + 蒙版 + 结果/错误整理
├── client.js             # Web 面板（composer.dock）
├── locale/en.json|zh.json# 插件清单显示名/描述
└── icon.svg              # 插件图标
```

数据流：

```
用户/Agent
  │  /psfill 或 ps_generative_fill
  ▼
pipeline.fill
  ├─ ps-bridge  → AppleScript → Photoshop ExtendScript：读文档/选区，duplicate+crop 导出 PNG
  ├─ image-api  → POST /v1/images/edits (multipart: model, prompt, image)
  └─ ps-bridge  → Photoshop：Place 为智能对象 → 缩放到选区 → 按选区建图层蒙版 → 重命名
```

细节：

- 智能对象回填：结果以智能对象放置，可再用 Photoshop 的「替换内容」非破坏地迭代；
- `fit`：`cover`（默认，保持比例铺满区域）、`stretch`（拉伸铺满）、`contain`（完整放入）；
- 无选区时 `region: auto` 会退化为当前图层范围、再退化为整幅画布；
- 结果图层名形如 `AI Fill 16:21:03 cyberpunk`，便于撤销与识别；
- MCP 的 128 个工具与插件命令使用同一个 Photoshop 实例，互不冲突。

---

## 6. 排障

| 现象 | 处理 |
|---|---|
| `Photoshop 操作失败：Photoshop 未运行` / AppleScript 报错 | 先手动启动 Photoshop 2026；确认系统设置 → 隐私与安全性 → 自动化里 Harness 允许控制 Photoshop。 |
| `图片 API 鉴权失败（401）` | 检查 `apiKey`（或 `PS_GENFILL_API_KEY`）；本机 curl 验证：`curl -H "Authorization: Bearer $KEY" https://chatgpt2api.343426.xyz/v1/models`。 |
| `图片 API 超时` | 生成/编辑通常 25–60s，接口偶发更慢；适当调大 `requestTimeoutMs`，或重试。 |
| `当前没有像素选区` | 用选框/套索/主体选择建选区，或让 Agent 调 `mcp__photoshop__photoshop_select_subject`。 |
| 区域太小 / 过大 | 扩大/缩小选区；上限 8192px 边长。 |
| 新图层位置不对 | 用 `fit: cover` + 重试；或先确认选区/图层 bounds（`/psstatus`）。 |
| MCP 工具不出现 | npx 首次下载失败或 npm 源不可用：检查 `~/.npm` 缓存与网络；MCP 行配置了 `npm_config_registry=https://registry.npmjs.org/` 规避镜像限制。 |
| 想彻底撤掉 | Settings → Plugins 里禁用/卸载 bundle；或 `plugin_manager remove_bundle`。 |

---

## 7. 安全说明

- 公开补丁不包含 API Key，也不包含开发者机器的绝对路径；使用者必须在 Settings 或环境变量中自行配置。
- 如果历史版本曾经提交过真实 Key，请立即在服务商后台撤销并重新生成；仅从文件中删除并不能让旧提交安全。
- 插件只写入 `outputDir` 与 Photoshop 文档；不修改系统设置。
- 图像编辑接口会将捕获的画布区域发送到你配置的第三方 API，请确认其隐私政策后再处理敏感图片。
- MCP 服务由本机 npx 启动，仅通过 stdio 与 Harness 连接。

---

## 8. 验证记录

见 `reports/`（Lead 汇总的安装、工具、Photoshop、API、面板验证结果）。
