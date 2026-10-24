// 由 Toonflow 声明式供应商生成，协议通道：image=openai-images / video=openai-videos

type MediaInput = { type: "url"; url: string; mimeType?: string } | { type: "base64"; data: string; mimeType: string } | { type: "binary"; data: Uint8Array; mimeType: string };
type MediaAsset = { mediaType: "image" | "video"; type: "url" | "base64"; url?: string; data?: string; mimeType?: string };
type ImageRequest = { model: string; prompt: string; images?: MediaInput[]; mask?: MediaInput; n?: number; ratio?: string; size?: string; quality?: string };
type VideoRequest = { model: string; prompt: string; mode?: unknown; images?: MediaInput[]; videos?: MediaInput[]; audios?: MediaInput[]; firstFrame?: MediaInput; lastFrame?: MediaInput; duration?: number; ratio?: string; resolution?: string; generateAudio?: boolean };
type ProviderContext = { config: Record<string, unknown>; signal?: AbortSignal; tool: { fetch: typeof fetch; errorMessage(value: unknown): string } };

const apiUrl = "https://api.yingce.tv/v1";

  const baseUrl = String(apiUrl).replace(/\/+$/, "");
  const pickSize = (size) => {
    const text = String(size ?? "").trim();
    if (!text) return "";
    if (/^\d+x\d+$/i.test(text)) return text.toLowerCase();
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
      if (typeof value === "string" && /^https?:\/\//i.test(value)) urls.push(value);
      else if (value && typeof value === "object" && typeof value.url === "string" && /^https?:\/\//i.test(value.url)) urls.push(value.url);
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
          if (typeof item === "string" && /^https?:\/\//i.test(item)) urls.push(item);
          else if (item && typeof item === "object") walk(item, depth + 1);
        }
      }
    };
    walk(payload, 0);
    return [...new Set(urls)];
  };


  const readUrl = (input) => {
    if (!input || typeof input !== "object") return null;
    if (input.type === "url" && typeof input.url === "string" && input.url) return input.url;
    if (input.type === "base64" && typeof input.data === "string" && input.data) {
      const data = input.data.startsWith("data:") ? input.data : `data:${input.mimeType || "image/png"};base64,${input.data}`;
      return data;
    }
    if (input.type === "binary" && input.data) {
      return `data:${input.mimeType || "image/png"};base64,${Buffer.from(input.data).toString("base64")}`;
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


const rules = [
  {
    "type": "input",
    "field": "apiKey",
    "title": "API Key",
    "value": "",
    "props": {
      "type": "password",
      "showPassword": true,
      "autocomplete": "off"
    }
  }
];

export default {
  id: "yingce",
  label: "影策中转站",
  version: "1.0.0",
  apiUrl: "https://api.yingce.tv/v1",
  rules,
  models: [
  {
    "id": "gpt-image-2.5",
    "label": "GPT Image 2.5",
    "type": "image",
    "mode": [
      "text",
      "singleImage"
    ]
  },
  {
    "id": "sd2.0-fast",
    "label": "Seedance 2.0 Fast",
    "type": "video",
    "mode": [
      "text",
      "singleImage"
    ],
    "durationResolutionMap": [
      {
        "duration": [
          5,
          10,
          15
        ],
        "resolution": [
          "480P",
          "720P"
        ]
      }
    ]
  }
],

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
};
