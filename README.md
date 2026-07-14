# Vision Agent API (Node.js / Fastify)

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

验证：`GET /health` → `vision_enabled: true`, `llm_enabled: true`, `runtime: "nodejs"`

## 快速开始

```bash
cd .\vision-agent-api\
npm install
npm run dev
```

默认：http://localhost:8000  
Health：http://localhost:8000/health

## 脚本

| 命令 | 说明 |
|------|------|
| `npm run dev` | 开发热重载 |
| `npm start` | 直接启动 |
| `npm run typecheck` | TypeScript 检查 |

## 目录约定

- `src/routes/*`：HTTP 适配（multipart / SSE / JSON）
- `src/services/*`、`src/agents/*`：业务逻辑，不依赖 Fastify（便于日后迁 Nest）
