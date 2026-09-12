from pydantic import BaseModel, Field
from typing import List, Optional
import time
import uuid
import hashlib

class AgentPassPassport(BaseModel):
    iss: str = "agentpass:iss:timmy"
    sub: str = "agent:timmy-governed-demo"
    aud: str = "timmy:governed:loop"
    delegated_by: str = "user:example"
    tenant_id: str = "tenant:example:startup"
    scopes: List[str] = Field(default_factory=lambda: [
        "workspace.read", 
        "workspace.write", 
        "context.read.openrouter_agent_sdk",
        "agent.run.openhands",
        "agent.run.openhands.headless",
        "context.read.openhands_sdk"
    ])
    allowed_tools: List[str] = Field(default_factory=lambda: [
        "workspace.*", 
        "mcp.*", 
        "git.*",
        "openhands.*"
    ])
    denied_tools: List[str] = Field(default_factory=lambda: [
        "gmail.*", 
        "stripe.*", 
        "slack.*"
    ])
    budget_usd: float = 1.00
    risk_level: str = "high"  # "low" | "medium" | "high"
    iat: float = Field(default_factory=time.time)
    exp: float = Field(default_factory=lambda: time.time() + 1200) # 20 minutes expiration
    jti: str = Field(default_factory=lambda: str(uuid.uuid4()))
    trace_id: str = Field(default_factory=lambda: str(uuid.uuid4()))

    def serialize(self) -> str:
        """
        Serializes the passport into a secure, redacted representation: agentpass:<first8>...<last8>
        """
        raw_token = f"{self.iss}:{self.sub}:{self.jti}:{self.iat}"
        token_hash = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()
        first_8 = token_hash[:8]
        last_8 = token_hash[-8:]
        return f"agentpass:{first_8}...{last_8}"

    def has_expired(self) -> bool:
        return time.time() > self.exp
