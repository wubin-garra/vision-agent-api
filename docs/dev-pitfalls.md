# Vision Agent 开发坑点

> 现象 → 先查什么。改代码前可对一下文末 Checklist。

## 速查表

| 现象 | 先查 |
|------|------|
| 分析很糊、confidence 很低 | DB / 日志里的 caption 是否超时降级；别以为一定是 Demo |
| 固定台灯示例 | 未配 LLM → Demo 模式（正常） |
| 手机连不上 API | `/health`、IP、同 WiFi、防火墙；Node 看进程是否真活着 |
| 洞察页一进就崩 | 是否**顶层** `import expo-speech-recognition`（Expo Go 会炸，要懒加载） |
| 没有麦克风按钮 | Expo Go 故意隐藏；要语音用 `expo run:android` |
| 键盘挡住输入 | 输入栏固定底部；Android `softwareKeyboardLayoutMode: resize` |
| 食识拍字段不全 | 是否传了 `agent_override=food_scan`；专项走完整链路 |
| 积分刷新没了 | 预期：还未持久化 / 未接 API |
| Gradle / Hermes 下载失败 | 用国内 Maven 镜像；Windows 注意路径过长（短 `GRADLE_USER_HOME`） |

## 架构（别踩错）

1. **DeepSeek 不能直接看图** → 视觉模型 caption（或自动模式视觉直出）+ DeepSeek 推理/追问。  
2. Caption 失败会降级成「尺寸+RGB」→ 后面全糊。国内可试 `VISION_PROVIDER=dashscope`。  
3. 追问必须带完整 insight + 历史 Q&A，不能只传标题。  
4. GPS 参数要真正写进 prompt / DB，否则附近推荐无效。

## 移动端配置

优先级：`EXPO_PUBLIC_API_URL`（.env）> `app.json extra` > Metro 推断局域网。  
改 .env 后需 Reload。局域网 HTTP 要允许 cleartext（Android）。

语音：`expo-speech` = 朗读；`expo-speech-recognition` = 说话转文字（需开发版）。

## Checklist（改代码前）

- [ ] 扩展 schema：旧 memory 兼容（Optional / 默认值）  
- [ ] 追问上下文完整  
- [ ] 原生模块禁止顶层 import（照顾 Expo Go）  
- [ ] 分析结果差 → 先查 caption / `/health`，再查 LLM  
- [ ] 不提交 `.env` 与密钥  

## 相关

- 产品：[../vision-agent-mobile/docs/vision-agent-产品文档.md](../../vision-agent-mobile/docs/vision-agent-产品文档.md)  
- 埋点：[../../vision-agent-mobile/docs/埋点.md](../../vision-agent-mobile/docs/埋点.md)  
- 食识拍：[../../vision-agent-mobile/docs/food-scan.md](../../vision-agent-mobile/docs/food-scan.md)  
- 积分：[../../vision-agent-mobile/docs/todo.md](../../vision-agent-mobile/docs/todo.md)
