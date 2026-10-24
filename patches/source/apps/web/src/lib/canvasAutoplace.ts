import type { CanvasContext } from "@toonflow/tool-canvas/runtime";

/**
 * Deterministically mirror media generated through the agent's `generateImage` /
 * `generateVideo` tools onto the active canvas.
 *
 * The media tools write files into the workspace and return only paths, so without
 * this bridge the canvas stays empty even though generation succeeded. We create a
 * matching media node, write the asset into its output handle, and wire it to the
 * node that supplied the source image (when one can be identified).
 *
 * Why not prompt the model to do it: model compliance is not guaranteed, and a missed
 * placement silently loses work. This runs in the same stream callback that receives
 * the tool result, so it executes on every successful generation.
 */

type MediaKind = "image" | "video";

export type GeneratedAsset = {
  kind: MediaKind;
  /** Workspace-relative path, e.g. `assets/scene1/video7cee.mp4`. */
  path: string;
  mimeType: string;
};

const KIND_NODE_TYPE: Record<MediaKind, string> = {
  image: "remote-imageNode",
  video: "remote-videoNode",
};

const KIND_OUTPUT_HANDLE: Record<MediaKind, string> = {
  image: "image",
  video: "video",
};

/** Tool name -> media kind. Generation tools return `details` as an asset array. */
const TOOL_KIND: Record<string, MediaKind> = {
  generateImage: "image",
  generateVideo: "video",
};

const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
};

function guessMimeType(kind: MediaKind, path: string): string {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXTENSION[extension] ?? (kind === "image" ? "image/png" : "video/mp4");
}

/**
 * Extract generated media paths from a tool result.
 *
 * The media tools answer with a text body shaped as
 * `<markdown>\n工作区文件：<path>` per asset and carry a `details` array. We accept the
 * explicit `details` shape when present and otherwise fall back to the paths embedded
 * in the text, so a wording change upstream degrades gracefully instead of dropping.
 */
export function readGeneratedAssets(toolName: string, result: string | undefined): GeneratedAsset[] {
  const kind = TOOL_KIND[toolName];
  if (!kind || !result) return [];

  const assets: GeneratedAsset[] = [];
  const seen = new Set<string>();

  const push = (rawPath: string) => {
    const path = rawPath.trim().replaceAll("\\", "/");
    if (!path || seen.has(path)) return;
    // Guard against absolute paths: the node tools only accept workspace-relative ones.
    if (path.startsWith("/") || /^[a-zA-Z]:/.test(path)) return;
    seen.add(path);
    assets.push({ kind, path, mimeType: guessMimeType(kind, path) });
  };

  const labelled = /工作区文件[：:]\s*(\S+)/g;
  for (const match of result.matchAll(labelled)) push(match[1]!);

  if (!assets.length) {
    // Fallback: the tool wraps each asset in a markdown link pointing at its path.
    const linked = /\]\(<([^>]+)>\)/g;
    for (const match of result.matchAll(linked)) push(match[1]!);
  }

  return assets;
}

/** Source image paths a generation call referenced, used to reconstruct the edge. */
export function readSourceReferences(args: Record<string, unknown> | undefined): string[] {
  if (!args) return [];
  const out: string[] = [];
  const images = args.images;
  if (Array.isArray(images)) {
    for (const item of images) {
      const path = (item as { path?: unknown } | null)?.path;
      if (typeof path === "string" && path.trim()) out.push(path.trim().replaceAll("\\", "/"));
    }
  }
  for (const key of ["firstFrame", "lastFrame", "image"] as const) {
    const value = args[key];
    const path = (value as { path?: unknown } | null)?.path;
    if (typeof path === "string" && path.trim()) out.push(path.trim().replaceAll("\\", "/"));
  }
  return [...new Set(out)];
}

type PlacementOptions = {
  canvas: CanvasContext;
  assets: GeneratedAsset[];
  /** Workspace-relative reference images the generation call consumed. */
  sources: string[];
  signal: AbortSignal;
  /** Existing canvas nodes, used to reuse a node that already shows the same asset. */
  nodes: { id: string; type: string; label?: string }[];
};

type PlacementResult = {
  placed: { nodeId: string; path: string }[];
  edges: { source: string; target: string }[];
  failures: string[];
};

/** Locate a node that already displays the given asset, so repeated retries update in place. */
function findMediaNode(options: PlacementOptions, asset: GeneratedAsset): string | undefined {
  const wantedType = KIND_NODE_TYPE[asset.kind];
  const fileName = asset.path.split("/").pop();
  if (!fileName) return undefined;
  return options.nodes.find(node => node.type === wantedType && node.label === fileName)?.id;
}

/** Locate a node whose label matches a reference image, to wire it as the upstream source. */
function findReferenceNode(options: PlacementOptions, referencePath: string): string | undefined {
  const fileName = referencePath.split("/").pop();
  if (!fileName) return undefined;
  return options.nodes.find(node => node.label === fileName)?.id;
}

/**
 * Place assets on the canvas: create node, bind the file to its output handle, then
 * connect any resolvable reference node into it. Each step is independent so a failure
 * on one asset never blocks the others; errors are collected and reported.
 */
export async function placeGeneratedAssets(options: PlacementOptions): Promise<PlacementResult> {
  const { canvas, assets, sources, signal } = options;
  const result: PlacementResult = { placed: [], edges: [], failures: [] };
  if (!assets.length) return result;

  for (const [index, asset] of assets.entries()) {
    signal.throwIfAborted();
    try {
      const existing = findMediaNode(options, asset);
      let nodeId = existing;

      if (!nodeId) {
        // addNode answers with nodeInfo(): { node: { id, type, label, position } }.
        const created = await canvas.call({
          name: "addNode",
          args: {
            type: KIND_NODE_TYPE[asset.kind],
            // Stagger placement so a batch of assets does not stack on one point.
            position: { x: 120 + (index % 4) * 360, y: 120 + Math.floor(index / 4) * 320 },
            label: asset.path.split("/").pop(),
          },
        }, signal) as { node?: { id?: string } } | undefined;
        nodeId = created?.node?.id;
      }
      if (!nodeId) throw new Error("未能创建画布节点");

      await canvas.call({
        name: "nodeTools",
        args: {
          nodeId,
          name: asset.kind === "image" ? "node:setImage" : "node:setVideo",
          args: { path: asset.path, mimeType: asset.mimeType },
        },
      }, signal);

      result.placed.push({ nodeId, path: asset.path });

      for (const source of sources) {
        const sourceNode = findReferenceNode(options, source);
        if (!sourceNode || sourceNode === nodeId) continue;
        try {
          await canvas.call({
            name: "connectNodes",
            args: {
              connections: [{
                source: sourceNode,
                sourceHandle: KIND_OUTPUT_HANDLE[asset.kind],
                target: nodeId,
                targetHandle: "in",
              }],
            },
          }, signal);
          result.edges.push({ source: sourceNode, target: nodeId });
        } catch {
          // A reference node created without an output handle cannot serve as a source;
          // the asset itself is already on the canvas, so this stays non-fatal.
        }
      }
    } catch (error) {
      result.failures.push(`${asset.path}：${error instanceof Error && error.message ? error.message : "放置失败"}`);
    }
  }

  if (result.placed.length) {
    // Read back the node list so later assets in the same stream can reuse these nodes.
    for (const placed of result.placed) {
      const label = placed.path.split("/").pop();
      const kind = assets.find(asset => asset.path === placed.path)?.kind;
      if (label && kind) options.nodes.push({ id: placed.nodeId, type: KIND_NODE_TYPE[kind], label });
    }
    try {
      await canvas.call({ name: "fitCanvas", args: {} }, signal);
    } catch {
      // Viewport adjustment is cosmetic; never fail placement over it.
    }
  }

  return result;
}
