# Vision Agent API

## 模型配置（推荐组合）

| 阶段 | 提供商 | 模型 |
|------|--------|------|
| **看图** | OpenAI | `gpt-4o-mini` |
| **推理/追问** | DeepSeek | `deepseek-v4-pro` |

```env
LLM_PROVIDER=deepseek
DEEPSEEK_API_KEY=sk-xxx

VISION_PROVIDER=openai
OPENAI_API_KEY=sk-xxx
OPENAI_VISION_MODEL=gpt-4o-mini
```

验证：`GET /health` → `vision_enabled: true`, `llm_enabled: true`

## 快速开始

```bash
cd .\vision-agent-api\
.venv\Scripts\uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

文档：http://localhost:8000/docs
