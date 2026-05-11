import Anthropic from "@anthropic-ai/sdk";

export function createAnthropicClient(apiKey: string): Anthropic {
  return new Anthropic({
    apiKey,
    baseURL: "https://api.anthropic.com",
  });
}
