type VideoRequest = {
  model: string;
  prompt: string;
  mode?: string | string[];
  images?: any[];
  videos?: any[];
  audios?: any[];
  firstFrame?: any;
  lastFrame?: any;
  duration?: number;
  ratio?: string;
  resolution?: string;
  generateAudio?: boolean;
  watermark?: boolean;
  other?: Record<string, unknown>;
};

type ImageRequest = {
  model: string;
  prompt: string;
  images?: any[];
  mask?: any;
  n?: number;
  ratio?: string;
  size?: string;
  quality?: string;
  outputFormat?: string;
  other?: Record<string, unknown>;
};

type Context = {
  config: { apiKey?: string };
  signal?: AbortSignal;
  tool: { fetch: typeof fetch };
};

type MediaAsset = {
  mediaType: "image" | "video" | "audio";
  type: "url" | "base64" | "binary";
  url?: string;
  data?: string | Uint8Array;
  mimeType?: string;
};

export default {
  id: "yuxibox",
  label: "YuxiBox",
  version: "2.0.0",
  requiresRemoteMedia: true,
  readme: "YuxiBox 聚合接口。支持 MiniMax H3 视频生成与 GPT Image 2.5 图片生成。注意：视频参考图/音频仅支持公网 HTTPS 链接，不支持直接上传。",
  rules: [
    {
      type: "input",
      field: "apiKey",
      title: "API Key",
      value: "",
      props: {
        type: "password",
        showPassword: true,
        autocomplete: "off",
      },
    },
    {
      type: "input",
      field: "logUrl",
      title: "任务日志网址",
      value: "",
      info: "填写后，生成失败时可在报错提示里一键打开该供应商的任务日志页。例如 https://yuxibox.cn/usage-logs/task",
      props: {
        type: "text",
        autocomplete: "off",
      },
    },
  ],
  models: [
    {
      "id": "minimax-h3-15s",
      "label": "MiniMax H3 (15s)",
      "type": "video",
      "mode": [
        "text",
        "singleImage",
        "imageReference:9",
        "audioReference:3"
      ]
    },
    {
      "id": "gpt-image-2.5",
      "label": "GPT Image 2.5",
      "type": "image",
      "mode": [
        "text",
        "singleImage",
        "multiReference"
      ],
      "imageSizes": [
        "1024x1024",
        "2048x2048",
        "4096x4096",
        "2048x1152",
        "1152x2048",
        "1792x1024",
        "1024x1792"
      ]
    }
  ],
  async generateVideo(this: Context, request: VideoRequest): Promise<MediaAsset[]> {
    this.signal?.throwIfAborted();

    const apiKey = this.config.apiKey?.trim();
    if (!apiKey) throw new Error("请填写 API Key");

    if (request.model !== "minimax-h3-15s") {
      throw new Error("不支持的模型: " + request.model);
    }

    const prompt = request.prompt?.trim();
    if (!prompt) throw new Error("提示词不能为空");

    let seconds: number | undefined;
    if (request.duration !== undefined) {
      seconds = Math.round(request.duration);
      if (seconds < 1 || seconds > 15) {
        throw new Error("视频时长必须在 1-15 秒之间");
      }
    }

    let resolution = request.resolution || "768p";
    if (resolution === "720p") resolution = "768p";
    if (resolution !== "480p" && resolution !== "768p") {
      throw new Error("分辨率仅支持 480p 或 768p");
    }

    let ratio = request.ratio || "9:16";
    if (ratio !== "16:9" && ratio !== "9:16") {
      throw new Error("画面比例仅支持 16:9 或 9:16");
    }

    const referenceImages: string[] = [];
    const audios: string[] = [];

    const extractHttpsUrl = (input: any, typeName: string) => {
      if (!input) return null;
      if (input.type === "url" && typeof input.url === "string") {
        if (!input.url.startsWith("https://")) {
          throw new Error(`YuxiBox 仅支持公网 HTTPS 链接作为${typeName}，请提供 HTTPS 地址`);
        }
        return input.url;
      }
      throw new Error(`YuxiBox 不支持直接上传${typeName}文件或 Base64，请提供公网 HTTPS 链接`);
    };

    if (request.firstFrame) {
      const url = extractHttpsUrl(request.firstFrame, "参考图片");
      if (url) referenceImages.push(url);
    }

    if (request.images && request.images.length > 0) {
      for (const img of request.images) {
        const url = extractHttpsUrl(img, "参考图片");
        if (url) referenceImages.push(url);
      }
    }

    if (referenceImages.length > 9) {
      throw new Error("参考图片最多支持 9 张");
    }

    if (request.audios && request.audios.length > 0) {
      for (const audio of request.audios) {
        const url = extractHttpsUrl(audio, "参考音频");
        if (url) audios.push(url);
      }
    }

    if (audios.length > 3) {
      throw new Error("参考音频最多支持 3 个");
    }

    if (request.other && Object.keys(request.other).length > 0) {
      throw new Error("该模型暂不支持额外的自定义参数");
    }

    const body: Record<string, any> = {
      model: "minimax-h3-15s",
      prompt: prompt,
      seconds: seconds,
      resolution: resolution,
      ratio: ratio,
    };

    if (referenceImages.length > 0) {
      body.reference_images = referenceImages;
    }
    if (audios.length > 0) {
      body.audios = audios;
    }

    const totalSignal = AbortSignal.any([AbortSignal.timeout(900000), ...(this.signal ? [this.signal] : [])]);

    const headers = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };

    this.signal?.throwIfAborted();

    const createResponse = await this.tool.fetch("https://yuxibox.cn/v1/videos", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: totalSignal,
    });

    if (!createResponse.ok) {
      const errText = await createResponse.text().catch(() => "");
      throw new Error(`提交视频任务失败 (HTTP ${createResponse.status}): ${errText || createResponse.statusText}`);
    }

    const createResult = await createResponse.json();
    const taskId = createResult?.id;

    if (!taskId || typeof taskId !== "string") {
      throw new Error("提交任务失败，未返回有效的任务 ID");
    }

    let videoUrl: string | null = null;
    const pollInterval = 5000;

    while (true) {
      this.signal?.throwIfAborted();
      totalSignal.throwIfAborted();

      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, pollInterval);
        const onAbort = () => {
          clearTimeout(timer);
          reject(new Error("Aborted"));
        };
        this.signal?.addEventListener("abort", onAbort, { once: true });
        totalSignal.addEventListener("abort", onAbort, { once: true });
      }).catch(err => {
        this.signal?.throwIfAborted();
        totalSignal.throwIfAborted();
        throw err;
      });

      this.signal?.throwIfAborted();

      const pollResponse = await this.tool.fetch(`https://yuxibox.cn/v1/videos/${taskId}`, {
        method: "GET",
        headers,
        signal: totalSignal,
      });

      if (!pollResponse.ok) {
        if (pollResponse.status >= 400 && pollResponse.status < 500 && pollResponse.status !== 429) {
          const errText = await pollResponse.text().catch(() => "");
          throw new Error(`查询任务失败 (HTTP ${pollResponse.status}): ${errText || pollResponse.statusText}`);
        }
        continue;
      }

      const pollResult = await pollResponse.json();
      const status = pollResult?.status;

      if (status === "completed") {
        videoUrl = pollResult.video_url || pollResult.download_url;
        if (!videoUrl) {
          throw new Error("任务已完成，但未返回视频地址");
        }
        break;
      } else if (status === "failed") {
        throw new Error("视频生成失败，请检查输入内容或稍后重试");
      }
    }

    this.signal?.throwIfAborted();

    return [
      {
        mediaType: "video",
        type: "url",
        url: videoUrl as string,
      },
    ];
  },
  async generateImage(this: Context, request: ImageRequest): Promise<MediaAsset[]> {
    this.signal?.throwIfAborted();

    const apiKey = this.config.apiKey?.trim();
    if (!apiKey) throw new Error("请填写 API Key");

    if (request.model !== "gpt-image-2.5") {
      throw new Error("不支持的模型: " + request.model);
    }

    const prompt = request.prompt?.trim();
    if (!prompt) throw new Error("提示词不能为空");

    // ACT: upstream rejects unlisted pixel sizes with HTTP 500 do_request_failed
    // (verified: 1536x864 fails, 2048x1152 and 1792x1024 succeed). Ratio must therefore
    // resolve to a whitelisted size rather than being forwarded verbatim.
    const SUPPORTED_SIZES = ["1024x1024", "2048x2048", "4096x4096", "2048x1152", "1152x2048", "1792x1024", "1024x1792"];
    const RATIO_SIZES: Record<string, string> = {
      "1:1": "2048x2048",
      "16:9": "2048x1152",
      "9:16": "1152x2048",
      "3:2": "1792x1024",
      "2:3": "1024x1792",
    };

    let size = request.size;
    if (size) {
      if (size === "1K") size = "1024x1024";
      else if (size === "2K") size = "2048x2048";
      else if (size === "4K") size = "4096x4096";
    }
    // A ratio request always wins over a SQUARE size: the node UI defaults to the
    // smallest listed size (1024x1024), so honouring only 2048x2048 would still produce
    // a square image for a 16:9 request. A non-square size the user explicitly picked is
    // respected and left alone.
    const requestedRatio = request.ratio?.trim();
    const SQUARE_SIZES = new Set(["1024x1024", "2048x2048", "4096x4096"]);
    if (requestedRatio && RATIO_SIZES[requestedRatio]) {
      const ratioSize = RATIO_SIZES[requestedRatio];
      const isSquareOrUnset = !size || SQUARE_SIZES.has(size);
      if (isSquareOrUnset) size = ratioSize;
    }
    if (size && !SUPPORTED_SIZES.includes(size)) {
      throw new Error(`尺寸仅支持 ${SUPPORTED_SIZES.join(", ")}，或 1K, 2K, 4K`);
    }

    const referenceImages: string[] = [];
    if (request.images && request.images.length > 0) {
      for (const img of request.images) {
        if (img.type === "url" && typeof img.url === "string") {
          referenceImages.push(img.url);
        } else if (img.type === "base64" && typeof img.data === "string") {
          const mime = img.mimeType || "image/png";
          referenceImages.push(`data:${mime};base64,${img.data}`);
        } else {
          throw new Error("参考图仅支持 URL 或 Base64 数据");
        }
      }
    }

    const body: Record<string, any> = {
      model: "gpt-image-2.5",
      prompt: prompt,
      response_format: "b64_json",
    };

    if (size) body.size = size;
    if (request.n) body.n = request.n;
    if (referenceImages.length > 0) body.image = referenceImages;
    
    if (request.other && Object.keys(request.other).length > 0) {
      Object.assign(body, request.other);
    }

    const totalSignal = AbortSignal.any([AbortSignal.timeout(300000), ...(this.signal ? [this.signal] : [])]);

    const response = await this.tool.fetch("https://yuxibox.cn/v1/images/generations", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: totalSignal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`生成图片失败 (HTTP ${response.status}): ${errText || response.statusText}`);
    }

    const result = await response.json();
    if (!result || !Array.isArray(result.data)) {
      throw new Error("接口返回格式异常");
    }

    const assets: MediaAsset[] = [];
    for (const item of result.data) {
      if (item.b64_json) {
        assets.push({
          mediaType: "image",
          type: "base64",
          data: item.b64_json,
          mimeType: "image/png",
        });
      } else if (item.url) {
        assets.push({
          mediaType: "image",
          type: "url",
          url: item.url,
        });
      }
    }

    if (assets.length === 0) {
      throw new Error("未生成任何图片，请检查输入内容");
    }

    this.signal?.throwIfAborted();

    return assets;
  }
};