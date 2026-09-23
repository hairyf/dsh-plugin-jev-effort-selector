# dsh-plugin-jev-effort-selector

中文 | [English](README.en.md)

让 [Jev](https://typesafe.ai) System One 模型替你决定每条消息该用多深的推理。

[DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 的推理等级只能手动切换：聊天问候浪费了 high，复杂重构又忘了从 low 调上来。这个插件在每轮首次模型调用前问一次 Jev——一个专做分类、不做生成的小模型——由它判断这条消息值多少思考量，然后改写这次调用的推理等级。

Jev 不是对话模型，单次判断约 300 token、几百毫秒，成本可以忽略。

```
你好                                    → Jev Off 100%
帮我把这段代码改成异步                    → Jev Medium 99%
设计一个支持百万并发的分布式消息队列        → Jev High 100%
```

判断结果显示在输入框右侧，紧挨模型选择器。

## 特性

- 🎚️ **按模型推导档位**：读取每个模型自己声明的推理等级，取最低档 / `medium` / `high`；不支持关闭思考的模型永远拿不到 `off`，`max`、`xhigh` 也不会被自动用掉
- 🧭 **上下文信封**：固定约 100 token 的三行摘要（上一轮等级 + 上一条消息 + 会话标题），让「继续」这类追问继承话题深度，不发对话历史
- ⬆️ **低置信度向上取**：概率低于阈值时在最可能的两档里选更高的——多想只费几个 token，少想可能直接答错
- 🛡️ **失败静默降级**：缺密钥、网络不通、超时、返回异常、等级不被支持，任何一种都沿用调用方已解析出的等级，不报错、不阻塞
- ⚙️ **配置落 `settings.yaml`**：设置卡片与配置文件双入口，改动热生效，插件不自带存储
- 🔀 **天然会话隔离**：芯片经会话投影下发，浏览器端零轮询、零 RPC，切换会话不串值；投影折的是 harness 内置的 `request/header`，插件不往会话日志写任何东西
- 🎛️ **档位可自定义**：`levels` 里按 `provider/model` 指定，2~5 档任意，提示文案随档位数自动适配

## 安装

前置：已安装 [DSH](https://github.com/deepseek-ai/deepseek-harness) 且 `pnpm` 在 PATH 上。

```sh
# 从 GitHub 安装（本插件零构建步骤，无需 allowBuilds 配置）
dsh plugin --profile web add github:justhalfbit/dsh-plugin-jev-effort-selector

# 重启 dsh web 生效
```

`web` 是 `dsh web`（浏览器界面）对应的 profile 名；用其他 profile（如 `tui`）时把 `web` 换成对应名字即可。
`dsh plugin add` 会自动把包写入 profile 依赖并追加到 `dsh.profile.bundles`，无需手工编辑。

重启后在 **设置 → 插件 → Jev Effort Selector** 里填 API 地址和 API 密钥即可。

卸载：`dsh plugin --profile web remove dsh-plugin-jev-effort-selector`，重启生效；配置保留在 `~/.dsh/settings.yaml` 的 `jev-effort-selector` 段落，可手动删除。

本地开发安装：克隆本仓库后 `pnpm install`，再 `dsh plugin --profile web add link:/绝对路径/dsh-plugin-jev-effort-selector`。

### 界面支持

| 运行形态 | 决策核心（拦截 / 判断 / 改写等级） | 输入框芯片 |
|---|---|---|
| `dsh web`（浏览器 GUI） | ✅ | ✅ |
| `tui` / `headless` | ✅ 全部可用 | ❌ 决策照常生效，只是没有可视指示 |

host 半与界面无关；client 半（芯片）声明 `platform: "web"`，仅在浏览器界面加载。

## 配置

所有配置项都写在 `~/.dsh/settings.yaml` 的 `jev-effort-selector` 段落，也可以直接在设置界面里改：

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `enabled` | `true` | 关掉后完全不干预，保持你手动选的等级 |
| `apiUrl` | `https://zenmux.ai/api/v1/systemone` | Jev System One API 地址 |
| `apiKey` | `''` | 字面量密钥逃生口；标了 `role('secret')`，永不随设置外发。常规情况留空 |
| `apiKeyEnv` | `JEV_API_KEY` | 凭据引用名，API 密钥以此名存放在凭据服务中。设置界面不显示此项，要改名请写 `settings.yaml` |
| `model` | `jev-latest` | Jev 模型路由 |
| `confidenceThreshold` | `0.6` | 低于该置信度时，在概率最高的两档里选更高的那档 |
| `timeoutMs` | `5000` | 超时后放弃 Jev，本次调用沿用调用方已解析出的等级 |
| `useContext` | `true` | 发送上下文信封，让「继续」这类追问继承话题深度 |
| `levels` | `{}` | 每个模型的档位映射，键为 `provider/model` |

### API 密钥存在哪

密钥**不进 `settings.yaml`**，走的是 DSH 的凭据服务，与官方「设置 → 模型」里自定义提供方的密钥完全同一条链路。设置卡片里的「API 密钥」框只做两件事：写入（`set`）和读状态（`describe`）——状态里只有「配没配、来自哪一层、能不能改」，**没有任何字段能装下密钥本身**，所以它永远不会回传到浏览器。

解析顺序（由凭据服务本身分层，最信任的优先）：

```
启动时继承的进程环境        只读，最高优先级
> ~/.dsh/.credentials.yaml  设置界面写入这里，权限 0600
> <启动目录>/.env           只读兜底
> ~/.dsh/.env               只读兜底
```

所以这三种方式都可以，任选其一：

```bash
# 1. 设置界面里填（落到 ~/.dsh/.credentials.yaml）
# 2. 导出到环境（优先级最高，界面会显示为只读）
export JEV_API_KEY=sk-...
# 3. 写进 ~/.dsh/.env
```

上层被占用时（例如已 export 环境变量），界面会如实显示「该层只读，请在其来源处修改」，而不是接受一个写完也不生效的保存。

## 档位是怎么定的

不同模型支持的推理等级不一样——有的不支持关闭思考，有的没有 `xhigh`。插件默认**读取每个模型自己声明的等级列表**，取最低档、`medium`、`high` 三档：

```
claude-opus-4-6   off · low · medium · high · max   →  off / medium / high
claude-opus-5     off · low · medium · high · xhigh · max  →  off / medium / high
claude-fable-5    low · medium · high · xhigh · max →  low / medium / high
```

最高档**刻意不取列表里最强的那个**：模型若提供 `max` 或 `xhigh`，自动档位用上它意味着每条被判为复杂的消息都花最贵的代价。这两档留给你在 `levels` 里显式指定。

不满意就在 `levels` 里指定，2~5 档都行，描述文案会自动适配（每档都需要一句独立的判定描述，所以超过 5 档会自动收敛到首、尾与均匀分布的 5 档——否则多出来的档位只能共用同一句描述，Jev 根本分不开）：

```yaml
jev-effort-selector:
  levels:
    host-llm-gateway/claude-opus-4-6:
      - "off"
      - medium
      - high
    host-llm-gateway/claude-fable-5:
      - low
      - high
```

没在 `levels` 里出现的模型继续走自动推导。声明的等级会先和模型实际广播的等级求交集：写错或该模型不支持的档位被直接剔除，剩下不足 2 档就退回自动推导。这一步是必须的——底层对不支持的等级是**在发请求前直接拒绝**，不做钳制也不做别名，所以一个手误若不拦住，会让每轮的第一步都失败，而不是被忽略。

## 上下文信封

孤立地看，「继续」就是一句琐碎的话——Jev 会判成 `off`，哪怕上一轮正在设计分布式事务引擎。

所以 `useContext` 打开时，插件会额外发送三行上下文：

```
Previous reasoning effort: high
Previous user message: 帮我设计一个分布式数据库的事务引擎，需要支持 MVCC...
Session topic: 分布式事务引擎设计
```

这不是把对话历史发出去——只有上一次的决策、上一条消息的前 200 字、以及 DSH 本来就有的会话标题，固定约 100 token，不随对话增长。系统提示词、工具结果、代码全都不会离开本机。

实测带上信封后，「继续」「好的，按这个方案来」这类追问能正确继承上一轮的深度。

## 低置信度往高了选

Jev 返回概率分布。当最高概率低于 `confidenceThreshold` 时，插件在概率最高的两档里选**更高**的那个。

多想一点只是多花几个 token，少想一点可能直接答错。

## 失败时会怎样

密钥缺失、网络不通、超时、返回格式不对、模型不支持选中的等级——任何一种情况都直接沿用调用方原本的推理等级，不报错、不阻塞对话。Jev 挂了你不会察觉，只是失去自动切换。

## 工作原理

```
agent/pre-step   捕获用户消息原文
       ↓
agent/request    ① 解析当前模型支持的等级 → 得到档位
  （仅 step 1）   ② 组装上下文信封
                 ③ 调 Jev
                 ④ 改写 LlmCallConfig.reasoningEffort
       ↓
request/header   harness 自己记下这次请求用的 config
  （内置事件）     （其中就带着被改写的 reasoningEffort）
       ↓
jevEffort        会话投影折上面那个事件，浏览器端用 useProjection 读取
   投影           → 输入框右侧的芯片，天然按会话隔离
```

插件**不往会话日志里写任何东西**。持久化的读路径会拒绝加载含有 harness 词汇表（`KNOWN_SESSION_EVENT_TYPES`）之外事件类型的会话——除非 envelope 带 `ignorable: true`，而 `Session.append()` 根本没有设置该标记的入口。于是插件自定义的会话事件在写它的那个进程里一切正常，却会在下次冷读时让整个会话永久打不开。芯片需要的数据本来就在内置的 `request/header` 里。

Host 半边声明 settings schema、由设置文档持久化；浏览器半边在 `settings.plugin.item` 上按同一 namespace 注册设置卡片。

## 已知行为

如果你的 provider 配了 `compat.forceAdaptiveThinking: true`，`off` 档不会真正关闭思考，只会降到最低——这是 gateway 的行为，不是插件能覆盖的。

## 许可

MIT
