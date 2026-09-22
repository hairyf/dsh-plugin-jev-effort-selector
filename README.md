# dsh-plugin-jev-effort-selector

让 [Jev](https://typesafe.ai) System One 模型替你决定每条消息该用多深的推理。

DeepSeek Harness 的推理等级只能手动切换：聊天问候浪费了 high，复杂重构又忘了从 low 调上来。这个插件在每轮首次模型调用前问一次 Jev——一个专做分类、不做生成的小模型——由它判断这条消息值多少思考量，然后改写这次调用的推理等级。

Jev 不是对话模型，单次判断约 300 token、几百毫秒，成本可以忽略。

```
你好                                    → Jev Off 100%
帮我把这段代码改成异步                    → Jev Medium 99%
设计一个支持百万并发的分布式消息队列        → Jev High 100%
```

判断结果显示在输入框右侧，紧挨模型选择器。

## 安装

```bash
npm i dsh-plugin-jev-effort-selector
```

DSH 会自动发现 `dsh.bundle.patch`，把插件行插入 host composition。重启后在 **设置 → 插件 → Jev Effort Selector** 里填接口地址和密钥即可。

## 配置

所有配置项都写在 `~/.dsh/settings.yaml` 的 `jev-effort-selector` 段落，也可以直接在设置界面里改：

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `enabled` | `true` | 关掉后完全不干预，保持你手动选的等级 |
| `apiUrl` | `https://zenmux.ai/api/v1/systemone` | Jev System One 接口地址 |
| `apiKey` | `''` | 接口密钥；留空则读下面这个环境变量 |
| `apiKeyEnv` | `JEV_API_KEY` | `apiKey` 为空时读取的环境变量名 |
| `model` | `jev-latest` | Jev 模型路由 |
| `confidenceThreshold` | `0.6` | 低于该置信度时，在概率最高的两档里选更高的那档 |
| `timeoutMs` | `5000` | 超时后放弃 Jev，本次调用沿用调用方已解析出的等级 |
| `useContext` | `true` | 发送上下文信封，让「继续」这类追问继承话题深度 |
| `levels` | `{}` | 每个模型的档位映射，键为 `provider/model` |

密钥建议走环境变量，不要写进 `settings.yaml`：

```bash
export JEV_API_KEY=sk-...
```

## 档位是怎么定的

不同模型支持的推理等级不一样——有的不支持关闭思考，有的没有 `xhigh`。插件默认**读取每个模型自己声明的等级列表**，从中取最低、中间、最高三档：

```
claude-opus-4-6   off · low · medium · high · max   →  off / medium / max
claude-fable-5    low · medium · high · xhigh · max →  low / medium / max
```

不满意就在 `levels` 里指定，档位数量任意（2~5 档都行，描述文案会自动适配）：

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

没在 `levels` 里出现的模型继续走自动推导。声明的等级如果模型不支持，那次判断会被丢弃，本次调用沿用调用方已解析出的等级。

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
                 ⑤ 追加 jev/effort 会话事件
       ↓
jevEffort        会话投影，浏览器端用 useProjection 读取
   投影           → 输入框右侧的芯片，天然按会话隔离
```

设置表单不是插件画的：Host 半边声明了 schema，DSH 自己渲染这个区块并负责持久化。

## 已知行为

如果你的 provider 配了 `compat.forceAdaptiveThinking: true`，`off` 档不会真正关闭思考，只会降到最低——这是 gateway 的行为，不是插件能覆盖的。

## 许可

MIT
