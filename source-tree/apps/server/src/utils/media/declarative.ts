import { z } from "zod";
import { t, translateMessage, validationOptions } from "@/lib/i18n";

/**
 * 声明式媒体供应商：用户只填表单，宿主生成符合 ProviderDefinition 契约的 .ts 源码。
 * 生成结果走现有 addMediaProvider 全链路（校验、加锁、版本、模型刷新），故无需改动 provider.ts。
 */

const protocolSchema = z.enum(["openai-images", "openai-videos"]);

const modelSchema = z.object({
  id: z.string().min(1).max(200),
  label: z.string().min(1).max(200),
  type: z.enum(["image", "video"]),
  mode: z.array(z.string().min(1)).optional(),
  durationResolutionMap: z.array(z.object({
    duration: z.array(z.number().positive()),
    resolution: z.array(z.string().min(1)),
  })).optional(),
  imageSizes: z.array(z.string().min(1)).optional(),
  imageRatios: z.array(z.string().min(1)).optional(),
}).catchall(z.json());

const channelSchema = z.object({
  capability: z.enum(["image", "video"]),
  protocol: protocolSchema,
  models: z.array(modelSchema).min(1).max(500),
});

export const declarativeProviderSchema = z.object({
  id: z.string().max(96).regex(/^[a-z][a-zA-Z0-9]*$/).refine(value => !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value), "供应商 ID 不能是系统保留文件名"),
  label: z.string().trim().min(1).max(200),
  apiUrl: z.url({ protocol: /^https?$/ }).refine(value => {
    const url = new URL(value);
    return !url.username && !url.password && !url.hash;
  }, "请填写不含凭据的 HTTP API 基础地址"),
  icon: z.string().max(200_000).optional(),
  readme: z.string().max(20_000).optional(),
  channels: z.array(channelSchema).min(1).max(4),
}).refine(value => new Set(value.channels.map(channel => channel.capability)).size === value.channels.length, "同一能力只能配置一个协议通道");

export type DeclarativeProviderConfig = z.infer<typeof declarativeProviderSchema>;

/** 生成内联的媒体引用读取逻辑；该文件在 VM 中执行，不能 import 任何模块。 */
const referenceHelpers = `
  const readUrl = (input) => {
    if (!input || typeof input !== "object") return null;
    if (input.type === "url" && typeof input.url === "string" && input.url) return input.url;
    if (input.type === "base64" && typeof input.data === "string" && input.data) {
      const data = input.data.startsWith("data:") ? input.data : \`data:\${input.mimeType || "image/png"};base64,\${input.data}\`;
      return data;
    }
    if (input.type === "binary" && input.data) {
      return \`data:\${input.mimeType || "image/png"};base64,\${Buffer.from(input.data).toString("base64")}\`;
    }
    return null;
  };
  const collectRefs = (list) => (Array.isArray(list) ? list : []).map(readUrl).filter(Boolean);
  const attachRefs = (body, refs) => {
    if (!refs.length) return body;
    body.image = refs[0];
    if (refs.length > 1) body.images = refs;
    return body;
  };
`;

const imageBody = `
  async generateImage(request) {
    const apiKey = String(this.config.apiKey ?? "").trim();
    if (!apiKey) throw new Error("请在媒体模型设置中填写 API Key");
    const prompt = String(request.prompt ?? "").trim();
    if (!prompt) throw new Error("请输入生成提示词");
    const body = { model: request.model, prompt };
    const size = normalizeSize(request.size, request.ratio);
    if (size) body.size = size;
    if (request.n) body.n = Math.max(1, Math.min(4, Math.floor(Number(request.n) || 1)));
    if (request.quality) body.quality = String(request.quality);
    attachRefs(body, collectRefs(request.images));
    const response = await this.tool.fetch(baseUrl + "/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
      body: JSON.stringify(body),
      signal: this.signal,
    });
    const payload = await readPayload(response, this);
    const urls = parseImageUrls(payload);
    if (!urls.length) throw new Error("供应商未返回图片结果");
    return urls.map((url) => ({ type: "url", url, mediaType: "image" }));
  },
`;

const videoBody = `
  async generateVideo(request) {
    const apiKey = String(this.config.apiKey ?? "").trim();
    if (!apiKey) throw new Error("请在媒体模型设置中填写 API Key");
    const prompt = String(request.prompt ?? "").trim();
    if (!prompt) throw new Error("请输入生成提示词");
    const body = { model: request.model, prompt };
    const seconds = normalizeSeconds(request.duration);
    if (seconds) body.seconds = seconds;
    if (request.resolution) body.resolution = String(request.resolution);
    if (request.ratio) body.ratio = String(request.ratio);
    const refs = collectRefs(request.images);
    const first = readUrl(request.firstFrame);
    const last = readUrl(request.lastFrame);
    if (first) refs.unshift(first);
    if (last) refs.push(last);
    attachRefs(body, [...new Set(refs)]);
    const response = await this.tool.fetch(baseUrl + "/videos", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
      body: JSON.stringify(body),
      signal: this.signal,
    });
    const created = await readPayload(response, this);
    const taskId = created && (created.id || created.task_id || (created.data && (created.data.id || created.data.task_id)));
    if (!taskId) throw new Error("供应商未返回视频任务 ID");
    const deadline = Date.now() + 20 * 60 * 1000;
    let delay = 4000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(Math.round(delay * 1.2), 15000);
      if (this.signal && this.signal.aborted) this.signal.throwIfAborted();
      const poll = await this.tool.fetch(baseUrl + "/videos/" + encodeURIComponent(taskId), {
        method: "GET",
        headers: { Authorization: "Bearer " + apiKey, Accept: "application/json" },
        signal: this.signal,
      });
      const payload = await readPayload(poll, this);
      const status = String((payload && (payload.status || (payload.data && payload.data.status))) || "").toLowerCase();
      if (status === "failed" || status === "failure" || status === "cancelled") {
        const reason = (payload && (payload.error || payload.fail_reason || payload.message)) || "视频生成失败";
        throw new Error(typeof reason === "string" ? reason : JSON.stringify(reason));
      }
      const urls = parseVideoUrls(payload);
      if (urls.length && (status === "completed" || status === "succeeded" || status === "success" || status === "")) {
        return urls.map((url) => ({ type: "url", url, mediaType: "video" }));
      }
    }
    throw new Error("视频生成超时（20 分钟），请稍后重试");
  },
`;

const sharedHelpers = `
  const baseUrl = String(apiUrl).replace(/\\/+$/, "");
  const pickSize = (size) => {
    const text = String(size ?? "").trim();
    if (!text) return "";
    if (/^\\d+x\\d+$/i.test(text)) return text.toLowerCase();
    const map = { "1k": "1024x1024", "2k": "2048x2048", "4k": "4096x4096", "512": "512x512" };
    return map[text.toLowerCase()] || "";
  };
  const ratioSize = (ratio) => {
    const map = { "1:1": "1024x1024", "16:9": "1536x864", "9:16": "864x1536", "4:3": "1152x864", "3:4": "864x1152", "3:2": "1248x832", "2:3": "832x1248", "21:9": "1680x720" };
    return map[String(ratio ?? "").trim()] || "";
  };
  const normalizeSize = (size, ratio) => pickSize(size) || ratioSize(ratio);
  const normalizeSeconds = (duration) => {
    const value = Math.round(Number(duration));
    if (!Number.isFinite(value) || value <= 0) return 0;
    return Math.max(5, Math.min(15, value));
  };
  const readPayload = async (response, context) => {
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
    if (!response.ok) {
      const detail = context.tool.errorMessage(payload) || (text ? text.slice(0, 300) : "");
      throw new Error("HTTP " + response.status + (detail ? "：" + detail : ""));
    }
    if (payload == null) throw new Error("供应商返回了无法解析的响应");
    return payload;
  };
  const parseImageUrls = (payload) => {
    const urls = [];
    const push = (value) => {
      if (typeof value === "string" && /^https?:\\/\\//i.test(value)) urls.push(value);
      else if (value && typeof value === "object" && typeof value.url === "string" && /^https?:\\/\\//i.test(value.url)) urls.push(value.url);
      else if (value && typeof value === "object" && typeof value.b64_json === "string" && value.b64_json) urls.push("data:image/png;base64," + value.b64_json);
    };
    const walk = (value, depth) => {
      if (depth > 4 || value == null) return;
      if (Array.isArray(value)) { value.forEach((item) => walk(item, depth + 1)); return; }
      if (typeof value === "object") {
        for (const key of ["data", "images", "output", "result", "results", "url", "b64_json"]) {
          if (key in value) walk(value[key], depth + 1);
        }
        if ("url" in value) push(value);
      } else push(value);
    };
    walk(payload, 0);
    return [...new Set(urls)];
  };
  const parseVideoUrls = (payload) => {
    const urls = [];
    const walk = (value, depth) => {
      if (depth > 4 || value == null) return;
      if (Array.isArray(value)) { value.forEach((item) => walk(item, depth + 1)); return; }
      if (typeof value === "object") {
        for (const key of ["download_url", "result_url", "video_url", "url", "metadata", "data", "output", "result"]) {
          const item = value[key];
          if (typeof item === "string" && /^https?:\\/\\//i.test(item)) urls.push(item);
          else if (item && typeof item === "object") walk(item, depth + 1);
        }
      }
    };
    walk(payload, 0);
    return [...new Set(urls)];
  };
`;

function jsonValue(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

/** 生成可直接交给 addMediaProvider 的 TypeScript 源码。 */
export function buildDeclarativeProvider(config: DeclarativeProviderConfig): string {
  const { id, label, apiUrl, icon, readme, channels } = config;
  const models = channels.flatMap(channel => channel.models.map(model => ({ ...model })));
  const duplicate = models.length !== new Set(models.map(model => model.id)).size;
  if (duplicate) {
    const seen = new Set<string>();
    for (const model of models) {
      if (seen.has(model.id)) throw Object.assign(new Error(t`模型 ${model.id} 重复`), { status: 400 });
      seen.add(model.id);
    }
  }
  const hasImage = channels.some(channel => channel.capability === "image");
  const hasVideo = channels.some(channel => channel.capability === "video");
  const imageChannel = channels.find(channel => channel.capability === "image");
  const videoChannel = channels.find(channel => channel.capability === "video");
  if (hasImage && imageChannel!.protocol !== "openai-images") throw Object.assign(new Error("图片通道暂只支持 openai-images 协议"), { status: 400 });
  if (hasVideo && videoChannel!.protocol !== "openai-videos") throw Object.assign(new Error("视频通道暂只支持 openai-videos 协议"), { status: 400 });

  const rules = [{
    type: "input",
    field: "apiKey",
    title: "API Key",
    value: "",
    props: { type: "password", showPassword: true, autocomplete: "off" },
  }];

  // 自定义供应商在 VM 中执行且禁止 import，故类型声明与辅助函数必须内联。
  const typePrelude = `
type MediaInput = { type: "url"; url: string; mimeType?: string } | { type: "base64"; data: string; mimeType: string } | { type: "binary"; data: Uint8Array; mimeType: string };
type MediaAsset = { mediaType: "image" | "video"; type: "url" | "base64"; url?: string; data?: string; mimeType?: string };
type ImageRequest = { model: string; prompt: string; images?: MediaInput[]; mask?: MediaInput; n?: number; ratio?: string; size?: string; quality?: string };
type VideoRequest = { model: string; prompt: string; mode?: unknown; images?: MediaInput[]; videos?: MediaInput[]; audios?: MediaInput[]; firstFrame?: MediaInput; lastFrame?: MediaInput; duration?: number; ratio?: string; resolution?: string; generateAudio?: boolean };
type ProviderContext = { config: Record<string, unknown>; signal?: AbortSignal; tool: { fetch: typeof fetch; errorMessage(value: unknown): string } };
`;

  const header = [
    `// 由 Toonflow 声明式供应商生成，协议通道：${channels.map(channel => `${channel.capability}=${channel.protocol}`).join(" / ")}`,
    typePrelude,
    `const apiUrl = ${JSON.stringify(apiUrl)};`,
    sharedHelpers,
    referenceHelpers,
  ].join("\n");

  const generateImage = hasImage ? imageBody : "";
  const generateVideo = hasVideo ? videoBody : "";

  return `${header}

const rules = ${jsonValue(rules)};

export default {
  id: ${JSON.stringify(id)},
  label: ${JSON.stringify(label)},
  version: "1.0.0",${icon ? `\n  icon: ${JSON.stringify(icon)},` : ""}${readme ? `\n  readme: ${JSON.stringify(readme)},` : ""}
  apiUrl: ${JSON.stringify(apiUrl)},
  rules,
  models: ${jsonValue(models)},
${generateImage}${generateVideo}};
`;
}

/** 校验并生成，异常信息统一为可读文案。 */
export function createDeclarativeProviderSource(input: unknown) {
  const parsed = declarativeProviderSchema.safeParse(input, validationOptions());
  if (!parsed.success) {
    throw Object.assign(new Error(parsed.error.issues.map(issue => translateMessage(issue.message)).join("; ")), { status: 400 });
  }
  return buildDeclarativeProvider(parsed.data);
}
