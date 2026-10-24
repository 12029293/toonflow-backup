import { z } from "zod";
import type { ToolDefinition, ToolPlugin } from "@toonflow/tools-scaffold/runtime";
import { audioGenerationSchema, imageGenerationSchema, listMediaModelsSchema, videoGenerationSchema } from "./runtime";

const configSchema = z.strictObject({
  allowImage: z.boolean().default(true),
  allowVideo: z.boolean().default(true),
  allowAudio: z.boolean().default(true),
});

// ACT: Shared reminder appended to every successful media generation. The canvas tools
// (addNode/connectNodes/node:setImage/node:setVideo) already exist, so the model only
// needs to be told to use them; keeping the wording media-agnostic covers all providers.
const CANVAS_PLACEMENT_HINT = [
  "\u5df2\u751f\u6210\u7684\u7d20\u6750\u9700\u540c\u6b65\u5230\u753b\u5e03\uff0c\u4f7f\u7528\u4ee5\u4e0b\u6d41\u7a0b\uff1a",
  "1) \u7528 addNode \u521b\u5efa\u5bf9\u5e94\u7c7b\u578b\u7684\u56fe\u50cf\u6216\u89c6\u9891\u8282\u70b9\uff08\u7c7b\u578b\u53d6\u81ea getCanvas({include:['nodeTypes']}) \u7684 availableNodeTypes\uff09\uff1b",
  "2) \u7528 nodeTools \u8c03\u7528\u8be5\u8282\u70b9\u7684 node:setImage \u6216 node:setVideo\uff0c\u628a\u4e0a\u9762\u7684\u5de5\u4f5c\u533a\u8def\u5f84\u5199\u5165\u8282\u70b9\u8f93\u51fa\uff1b",
  "3) \u82e5\u8be5\u7d20\u6750\u7531\u53e6\u4e00\u4e2a\u8282\u70b9\u4ea7\u751f\uff08\u5982\u53c2\u8003\u56fe\u3001\u9996\u5e27\u6216\u63d0\u793a\u8bcd\u8282\u70b9\uff09\uff0c\u7528 connectNodes \u6309\u771f\u5b9e\u6570\u636e\u6d41\u8fde\u63a5\uff08\u56fe\u50cf\u8f93\u51fa \u2192 \u89c6\u9891\u8f93\u5165\u7b49\uff09\uff1b",
  "4) \u7528 fitCanvas \u5c55\u793a\u7ed3\u679c\uff0c\u5e76\u544a\u77e5\u7528\u6237\u8282\u70b9\u540d\u79f0\u3002",
  "\u82e5\u5f53\u524d\u9875\u9762\u6ca1\u6709\u6fc0\u6d3b\u753b\u5e03\u6216\u753b\u5e03\u5de5\u5177\u4e0d\u53ef\u7528\uff0c\u5982\u5b9e\u544a\u77e5\u7528\u6237\u5e76\u4fdd\u7559\u5de5\u4f5c\u533a\u6587\u4ef6\uff0c\u4e0d\u8981\u4f2a\u9020\u653e\u7f6e\u7ed3\u679c\u3002",
].join("\n");

const plugin: ToolPlugin = {
  validateConfig: config => configSchema.parse(config),
  createTools({ media, config }) {
    if (!media) return [];
    const permissions = configSchema.parse(config);
    const generationTools = ([
      { name: "generateImage", mediaType: "image", enabled: permissions.allowImage, label: "生成图片", parameters: imageGenerationSchema, description: "根据提示词和可选的工作区参考图生成图片。" },
      { name: "generateVideo", mediaType: "video", enabled: permissions.allowVideo, label: "生成视频", parameters: videoGenerationSchema, description: "根据提示词和可选的工作区图片、视频、音频、首尾帧生成视频。按模型能力设置生成模式、时长、分辨率和音频。" },
      { name: "generateAudio", mediaType: "audio", enabled: permissions.allowAudio, label: "生成音频", parameters: audioGenerationSchema, description: "根据文本或提示词和可选的工作区参考图片和音频生成音频。按模型能力设置音色、语速、音量、语种、采样率和格式。" },
    ] as const).filter(operation => operation.enabled);
    if (!generationTools.length) return [];
    const listTool: ToolDefinition = {
      name: "listMediaModels",
      label: "查询媒体模型",
      description: "查询已允许生成的媒体模型，返回 providerId、modelId、类型、模式及支持的画幅、时长、分辨率或音色。生成前先查询，不能猜测模型 ID。",
      parameters: z.toJSONSchema(listMediaModelsSchema, { io: "input", target: "draft-07" }),
      async execute(_id, params, signal) {
        listMediaModelsSchema.parse(params);
        signal?.throwIfAborted();
        const result = (await media.listModels()).filter(model => generationTools.some(operation => operation.mediaType === model.type));
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      },
    };
    return [listTool, ...generationTools.map<ToolDefinition>(operation => ({
      name: operation.name,
      label: operation.label,
      description: `${operation.description}providerId 和 modelId 必须来自 listMediaModels。引用素材的 path 及 outputDirectory 均为工作区相对路径；省略输出目录使用默认媒体目录。等待生成完成后返回已保存的文件路径，不返回 Base64。`,
      promptSnippet: "生成媒体前先查询 listMediaModels，复用实际模型和工作区参考素材。",
      promptGuidelines: operation.mediaType === "video" ? [
        "只要工作区已有可用的人物、场景、道具或首帧参考图，生成视频时必须传入 images 或 firstFrame，不得在未告知用户的情况下自行取消参考图。",
        "视频生成的 mode 选 text 就等于主动放弃参考图；有参考图时必须用带图模式（如 singleImage、multiReference 或首尾帧）。",
        "该规则适用于所有视频模型与供应商；若某次生成因参考图失败，应先如实报错，而不是默默降级为纯文本。",
      ] : undefined,
      parameters: z.toJSONSchema(operation.parameters, { io: "input", target: "draft-07" }),
      executionMode: "sequential",
      async execute(_id, params, signal) {
        signal?.throwIfAborted();
        const result = await media[operation.name](operation.parameters.parse(params), signal);
        // ACT: Agent-generated media must also land on the canvas so the user keeps a
        // browsable, persistent graph instead of only loose files. Ask the model to
        // materialise each asset as a node and wire it to its source.
        const placed = result.map(asset => `${asset.mediaType}|${asset.path}`).join("\n");
        const text = result.map(asset => {
          const url = asset.path.replaceAll("\\", "/").split("/").map(encodeURIComponent).join("/");
          const preview = asset.mediaType === "image" ? `![生成图片](<${url}>)` : `[${asset.mediaType === "audio" ? "播放生成音频" : "查看生成视频"}](<${url}>)`;
          return `${preview}\n工作区文件：${asset.path}`;
        }).join("\n\n");
        return {
          content: [{ type: "text", text: `${text}\n\n${CANVAS_PLACEMENT_HINT}\n\n${placed}` }],
          details: result,
        };
      },
    }))];
  },
};

export default plugin;
