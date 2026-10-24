import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

const router = Router();

/**
 * 只有明确命中视频特征才判为视频；其余一律图片。
 * 中转站模型名极不统一（sd2.0-fast、seedance-2.5、wan3.0-video、nano-banana-pro…），
 * 因此用白名单式特征词，避免把图片模型误判成视频。
 */
const videoHints = [
  "sd2", "seedance", "veo", "sora", "kling", "hailuo", "minimax-video", "jimeng",
  "vidu", "runway", "pika", "luma", "wan3", "wan2", "wanx", "h3-video", "video",
];
const imageHints = ["image", "imagen", "dall-e", "dalle", "banana", "flux", "midjourney", "mj-", "sd3", "sd-3", "stable-diffusion"];
const textHints = ["gpt-4", "gpt-5", "gpt-3", "deepseek", "claude", "gemini-2", "gemini-3", "glm", "kimi", "qwen", "llama", "mistral", "o1", "o3", "o4", "chat", "reasoner"];

/** 媒体供应商只关心图片/视频；命中文本特征的模型直接排除，避免误配到画布。 */
function detectType(id: string): "image" | "video" | null {
  const name = id.toLowerCase();
  if (videoHints.some(hint => name.includes(hint))) return "video";
  if (imageHints.some(hint => name.includes(hint))) return "image";
  if (textHints.some(hint => name.includes(hint))) return null;
  return "image";
}

export default router.post("/", validateFields({
  apiUrl: z.url({ protocol: /^https?$/ }).refine(value => {
    const url = new URL(value);
    return !url.username && !url.password && !url.hash;
  }, "请填写不含凭据的 HTTP API 基础地址"),
  apiKey: z.string().max(8192),
}), async (req, res) => {
  const { apiUrl, apiKey } = req.body as { apiUrl: string; apiKey: string };
  const base = apiUrl.replace(/\/+$/, "");
  const response = await fetch(`${base}/models`, {
    headers: { Accept: "application/json", ...(apiKey.trim() ? { Authorization: `Bearer ${apiKey.trim()}` } : {}) },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw Object.assign(new Error(`获取模型列表失败（HTTP ${response.status}）${detail ? `：${detail.slice(0, 200)}` : ""}`), { status: 400 });
  }
  const payload = await response.json().catch(() => null) as { data?: unknown[] } | unknown[] | null;
  const list = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload!.data : [];
  const models = list.map((item: unknown) => {
    const record = (item ?? {}) as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!id) return null;
    const label = typeof record.display_name === "string" ? record.display_name : typeof record.name === "string" ? record.name : id;
    const type = detectType(id);
    return type ? { id, label: label.trim() || id, type } : null;
  }).filter(Boolean);
  res.json(success(models));
});
