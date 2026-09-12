import json
from founder_terminal.openrouter.policy import OpenRouterPolicy

class PayloadGenerator:
    """
    Generates syntax-highlightable configuration payloads demonstrating
    SDK wiring and dynamic routing options.
    """
    
    @staticmethod
    def generate_typescript_agent_sdk(policy: OpenRouterPolicy) -> str:
        fallback_list = json.dumps([policy.primary_model] + policy.fallback_models)
        return f"""// OpenRouter Agent SDK (TypeScript) - CallModel & Cost Guards
import {{ OpenRouterAgentSDK }} from "@openrouter/sdk";

const agent = new OpenRouterAgentSDK({{
  apiKey: process.env.OPENROUTER_API_KEY,
  serviceTier: "{policy.service_tier.lower() if policy.service_tier else 'auto'}"
}});

const response = await agent.callModel({{
  model: "{policy.primary_model}",
  models: {fallback_list},
  messages: [
    {{ role: "user", content: "Analyze repository and score shipability." }}
  ],
  tools: [
    {{
      name: "repo_map_tool",
      description: "Extracts directory structure and imports map"
    }}
  ],
  stopWhen: {{
    maxCost: {policy.max_run_cost_usd:.4f}, // Cost Guard activated!
    maxSteps: 15
  }},
  provider: {{
    zdr: {str(policy.zdr).lower()} // Zero Data Retention Toggle
  }}
}});

console.log(`Agent response model: ${{response.model}}`);
console.log(`Final billed cost: ${{response.cost}}`);
"""

    @staticmethod
    def generate_openai_python_sdk(policy: OpenRouterPolicy) -> str:
        fallback_list = json.dumps([policy.primary_model] + policy.fallback_models)
        cache_hdr = "enabled" if policy.cache_enabled else "disabled"
        return f"""# OpenAI Python SDK Wrapper with OpenRouter Failover Pipeline
import os
from openai import OpenAI

client = OpenAI(
    base_url="https://openrouter.ai/api/v1",
    api_key=os.environ.get("OPENROUTER_API_KEY")
)

# OpenRouter automatic failovers must go inside 'extra_body'
response = client.chat.completions.create(
    model="{policy.primary_model}",
    messages=[
        {{"role": "user", "content": "Scaffold a Cloudflare Worker."}}
    ],
    extra_body={{
        "models": {fallback_list}, # Automatic Failovers Chain
        "provider": {{
            "zdr": {str(policy.zdr).lower()} # Zero Data Retention
        }},
        "service_tier": "{policy.service_tier.lower() if policy.service_tier else 'auto'}"
    }},
    extra_headers={{
        "HTTP-Referer": "https://founder-terminal.example.dev",
        "X-Title": "TIMMY AgentOps Control Plane",
        "OpenRouter-Response-Cache": "{cache_hdr}"
    }}
)

print(f"Served by: {{response.model}}")
"""

    @staticmethod
    def generate_raw_json(policy: OpenRouterPolicy) -> str:
        fallback_list = [policy.primary_model] + policy.fallback_models
        payload = {
            "model": policy.primary_model,
            "models": fallback_list,
            "messages": [
                {
                    "role": "user",
                    "content": "Verify workspace sandboxes."
                }
            ],
            "provider": {
                "zdr": policy.zdr
            },
            "service_tier": policy.service_tier.lower() if policy.service_tier else "auto",
            "transforms": ["middle-out"]
        }
        return json.dumps(payload, indent=2)

if __name__ == "__main__":
    print("Testing payload generator...")
    policy = OpenRouterPolicy()
    print("TypeScript SDK:")
    print(PayloadGenerator.generate_typescript_agent_sdk(policy))
