# 上下文记忆优化

## 背景

原链路在「视觉描述 → 推理 → 追问」过程中存在上下文丢失：

- 追问只传 `title - category`，不含完整洞察
- 多轮追问未带入历史 Q&A
- GPS 已接收但未写入 prompt / 数据库
- Caption 可能静默省略某些维度

## 优化目标

**分层传递、结构化槽位、关键节点不丢信息。**

```
原图 → Caption（缓存）→ 分析洞察 → 存库
                              ↓
                    追问 = Caption + 完整洞察 + 历史追问 + GPS
```

## 改动一览

| 优先级 | 内容 | 效果 |
|--------|------|------|
| P0 | 追问传入完整 `insight_json` + `followups` 历史 | 多轮追问不「失忆」 |
| P1 | GPS 写入分析与追问 prompt，并存入 DB | 提升 `local_guide` 准确度 |
| P2 | Caption 五段强制输出，无则写「未观察到」 | 减少静默遗漏 |

## 上下文分层

| 层级 | 内容 | 职责 |
|------|------|------|
| L0 | System prompt + JSON Schema | 输出格式、角色、必填字段 |
| L1 | `image_caption`（视觉模型生成，分析后缓存） | 「看到了什么」 |
| L2 | 完整洞察、追问历史、GPS、`agent_id`、`locale` | 「已经知道什么」 |

## 追问上下文模板

```
Locale: zh-CN
Agent: local_guide
拍摄位置：纬度 31.230000，经度 121.470000

【图片视觉描述】
{caption}

【已有洞察】
{完整 insight_json}

【历史追问】
Q1: ...  A1: ...
Q2: ...  A2: ...

【当前问题】
{question}
```

## 涉及文件

**后端**

- `app/services/context.py` — 上下文格式化（新增）
- `app/services/vlm.py` — 分析 / 追问入参扩展
- `app/api/routes/analyze.py` — 打通 GPS 与完整追问上下文
- `app/services/database.py` — `memories` 表新增 `latitude`、`longitude`
- `app/agents/prompts.py` — 追问规则、`local_guide` GPS 提示
- `app/services/vision.py` — Caption 检查清单

**移动端**

- `src/utils/location.ts` — 拍照时获取 GPS（新增）
- `src/services/api.ts` — 分析请求携带经纬度
- `src/screens/CameraScreen.tsx` — 调用位置服务
- `app.json` — iOS / Android 位置权限

## 数据流

### 分析 `/analyze`

1. 视觉模型生成 `caption` 并缓存
2. 携带 `caption` + GPS → 生成结构化洞察
3. 存库：`insight_json`、`image_caption`、`latitude`、`longitude`

### 追问 `/followup`

1. 从 DB 读取：`insight_json`、`followups_json`、`image_caption`、GPS
2. 组装完整上下文 → LLM 回答
3. 追加本轮 Q&A 到 `followups_json`

## 部署注意

- 重启后端后 DB 自动迁移新增列（`latitude`、`longitude`）
- 移动端需重新构建以生效位置权限
- GPS 未授权时不影响主流程，prompt 中显示「拍摄位置：未提供」
