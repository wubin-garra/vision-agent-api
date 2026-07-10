from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    app_name: str = "Vision Agent API"
    debug: bool = True
    api_prefix: str = "/v1"

    # 文本推理（DeepSeek 推荐）
    llm_provider: str = "deepseek"
    deepseek_api_key: str = ""
    deepseek_base_url: str = "https://api.deepseek.com"
    deepseek_llm_model: str = "deepseek-v4-pro"
    deepseek_router_model: str = "deepseek-v4-flash"

    # OpenAI 文本（可选）
    openai_api_key: str = ""
    openai_base_url: str = "https://api.openai.com/v1"
    openai_llm_model: str = "gpt-4o"
    openai_router_model: str = "gpt-4o-mini"

    # 图片理解（DeepSeek 官方 API 不支持 image_url，需单独配置视觉模型）
    vision_provider: str = "dashscope"
    dashscope_api_key: str = ""
    dashscope_base_url: str = "https://dashscope.aliyuncs.com/compatible-mode/v1"
    dashscope_vision_model: str = "qwen-vl-max"

    openai_vision_api_key: str = ""
    openai_vision_model: str = "gpt-4o-mini"

    database_url: str = "sqlite+aiosqlite:///./vision_agent.db"
    upload_dir: str = "./uploads"
    max_image_size: int = 1024
    jwt_secret: str = "dev-secret-change-in-production"
    jwt_algorithm: str = "HS256"
    cache_ttl_seconds: int = 86400
    default_locale: str = "zh-CN"

    @property
    def llm_api_key(self) -> str:
        if self.llm_provider.lower() == "deepseek":
            return self.deepseek_api_key
        return self.openai_api_key

    @property
    def llm_base_url(self) -> str:
        if self.llm_provider.lower() == "deepseek":
            return self.deepseek_base_url
        return self.openai_base_url

    @property
    def llm_model(self) -> str:
        if self.llm_provider.lower() == "deepseek":
            return self.deepseek_llm_model
        return self.openai_llm_model

    @property
    def router_model(self) -> str:
        if self.llm_provider.lower() == "deepseek":
            return self.deepseek_router_model
        return self.openai_router_model

    @property
    def llm_enabled(self) -> bool:
        return bool(self.llm_api_key.strip())

    @property
    def vision_enabled(self) -> bool:
        provider = self.vision_provider.lower()
        if provider == "dashscope":
            return bool(self.dashscope_api_key.strip())
        if provider == "openai":
            key = self.openai_vision_api_key or self.openai_api_key
            return bool(key.strip())
        return False

    @property
    def demo_mode(self) -> bool:
        return not self.llm_enabled


settings = Settings()
