<template>
  <el-dialog
    v-model="visible"
    :title="mode === 'builtin' ? '添加媒体供应商' : '添加自定义媒体供应商'"
    :width="mode === 'builtin' ? 'min(860px, 94vw)' : activeTab === 'form' ? 'min(820px, 94vw)' : 'min(760px, 94vw)'"
    alignCenter
    appendToBody
    destroyOnClose
    :closeOnClickModal="false"
    :closeOnPressEscape="!saving"
    :showClose="!saving">
    <div v-if="mode === 'builtin'" class="providerPicker">
      <aside class="providerSidebar" aria-label="选择厂商">
        <button
          v-for="item in mediaProviders"
          :key="item.id"
          class="providerItem"
          type="button"
          :disabled="saving"
          :aria-pressed="selectedProvider === item.id"
          @click="selectedProvider = item.id">
          <img v-if="item.icon" class="providerLogo" :class="{ monochrome: item.id === 'tfRouter' }" :src="item.icon" alt="" />
          <modelIcon v-else :model="item.id" :size="18" />
          <span>{{ item.label }}</span>
        </button>
      </aside>
      <el-scrollbar class="providerDetails">
        <section v-if="activeProvider" :key="selectedProvider" class="providerContent" :aria-label="activeProvider.label">
          <div class="providerHeader">
            <h3>{{ activeProvider.label }}</h3>
            <el-tag v-if="activeProvider.version" size="small" type="info" effect="plain">v{{ activeProvider.version }}</el-tag>
          </div>
          <messageMarkdown v-if="providerReadme" class="providerReadme" :content="providerReadme" />
          <el-divider v-if="providerReadme" contentPosition="left">连接配置</el-divider>
          <form-create v-model:api="formApi" :rule="providerRules" :option="formOptions" />
          <div class="modelHeader">
            <el-text tag="strong">模型列表 <el-text type="info">{{ models.length }}</el-text></el-text>
          </div>
          <el-table v-if="models.length" class="modelList" :data="models" rowKey="id" aria-label="模型列表">
            <el-table-column prop="id" label="模型 ID" minWidth="220" showOverflowTooltip />
            <el-table-column prop="label" label="显示名称" minWidth="180" showOverflowTooltip />
          </el-table>
          <el-alert v-if="formError" :title="formError" type="error" :closable="false" showIcon />
        </section>
      </el-scrollbar>
    </div>
    <el-scrollbar v-else maxHeight="min(65dvh, calc(100dvh - 160px))">
      <div class="dialogContent">
        <el-form class="importForm" labelPosition="top" :disabled="saving" @submit.prevent>
          <el-form-item class="methodField" label="添加方式">
            <el-segmented v-model="activeTab" :options="addMethods" block ariaLabel="添加方式">
              <template #default="{ item }">
                <span class="methodOption">
                  <component :is="item.icon" :size="16" aria-hidden="true" />
                  {{ item.label }}
                </span>
              </template>
            </el-segmented>
          </el-form-item>
          <template v-if="activeTab === 'form'">
            <el-form class="declarativeForm" labelPosition="top" :disabled="saving" @submit.prevent>
              <div class="formRow">
                <el-form-item label="供应商 ID" required>
                  <el-input v-model="declarative.id" placeholder="英文小写标识，如 yingce" aria-label="供应商 ID" />
                </el-form-item>
                <el-form-item label="显示名称" required>
                  <el-input v-model="declarative.label" placeholder="如 影策中转站" aria-label="显示名称" />
                </el-form-item>
              </div>
              <el-form-item label="API 地址" required>
                <el-input v-model="declarative.apiUrl" placeholder="https://api.example.com/v1" aria-label="API 基础地址" />
              </el-form-item>
              <el-form-item label="API Key">
                <el-input v-model="declarative.apiKey" type="password" showPassword placeholder="sk-..." aria-label="API Key" />
                <el-text class="fieldHint" type="info" size="small">安装后在同一页面即可修改，无需重新生成代码。</el-text>
              </el-form-item>
              <el-form-item label="协议通道">
                <div class="channelList">
                  <div v-for="(channel, index) in declarative.channels" :key="index" class="channelRow">
                    <el-select v-model="channel.capability" class="channelCapability" aria-label="通道能力">
                      <el-option label="图片" value="image" />
                      <el-option label="视频" value="video" />
                    </el-select>
                    <el-select v-model="channel.protocol" class="channelProtocol" aria-label="协议">
                      <el-option
                        v-for="item in protocolsFor(channel.capability)"
                        :key="item.value"
                        :label="item.label"
                        :value="item.value" />
                    </el-select>
                    <el-button :icon="IconTrash" text :disabled="declarative.channels.length <= 1" @click="removeChannel(index)" aria-label="删除通道" />
                  </div>
                  <el-button v-if="declarative.channels.length < 2" :icon="IconPlus" text @click="addChannel">添加通道</el-button>
                </div>
              </el-form-item>
              <el-form-item :label="`模型列表（${declarative.channels.reduce((total, item) => total + item.models.length, 0)}）`">
                <div class="modelTools">
                  <el-button :icon="IconDownload" :loading="fetchingModels" :disabled="!declarative.apiUrl.trim()" @click="fetchDeclarativeModels">从接口获取模型</el-button>
                  <el-button :icon="IconPlus" text @click="addManualModel">手动添加</el-button>
                </div>
                <div v-if="declarativeModels.length" class="modelChips">
                  <el-checkbox
                    v-for="model in declarativeModels"
                    :key="model.id"
                    :modelValue="selectedModelIds.has(model.id)"
                    :label="`${model.label || model.id}`"
                    @change="toggleModel(model)" />
                </div>
                <el-text v-else class="fieldHint" type="info" size="small">先填写 API 地址与 Key，点击「从接口获取模型」；也可手动添加。</el-text>
              </el-form-item>
            </el-form>
          </template>
          <el-form-item v-else-if="activeTab === 'file'" class="sourceField" label="供应商文件">
            <div class="fileImport">
              <div class="fileSource">
                <!-- ACT: Android 会把 .ts 识别为视频，选中后再校验扩展名和大小。 -->
                <input ref="fileInput" type="file" :accept="isMobile ? undefined : '.ts'" hidden :disabled="saving" @change="readSourceFile" />
                <el-input :modelValue="fileName" :prefixIcon="IconFileCode" placeholder="尚未选择文件" readonly aria-label="已选择的供应商文件" />
                <el-button :icon="IconFolderOpen" @click="fileInput?.click()">选择文件</el-button>
              </div>
              <el-text class="fieldHint" type="info" size="small">支持 .ts 文件，最大 1 MB。</el-text>
            </div>
          </el-form-item>
          <el-form-item v-else class="sourceField" label="供应商代码">
            <el-input v-model="code" class="sourceInput" type="textarea" dir="ltr" :rows="10" resize="none" aria-label="供应商代码" />
          </el-form-item>
        </el-form>
        <section class="providerTips" aria-label="使用 AI 生成供应商">
          <h4>还没有供应商文件？</h4>
          <p>让 AI 读取接口文档并生成代码，遇到登录可手动操作。</p>
          <div class="assistantActions">
            <el-button type="primary" :icon="IconSparkles" :loading="openingAgent" :disabled="!modelChoices.length || saving" @click="openAgent">AI 生成供应商</el-button>
            <el-button :icon="IconCopy" @click="copyPrompt">复制提示词给其他 AI</el-button>
          </div>
          <el-text v-if="!modelChoices.length" class="fieldHint" type="info" size="small">请先在文本模型设置中配置模型。</el-text>
          <details class="promptDetails" :open="promptExpanded" @toggle="promptExpanded = ($event.target as HTMLDetailsElement).open">
            <summary>查看完整提示词</summary>
            <el-input v-if="promptExpanded" :modelValue="providerPrompt" type="textarea" :rows="10" resize="none" readonly aria-label="供应商开发提示词" />
          </details>
        </section>
        <el-alert v-if="formError" class="formError" :title="formError" type="error" :closable="false" showIcon />
      </div>
    </el-scrollbar>
    <template #footer>
      <el-button :disabled="saving" @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="saving" :disabled="activeTab !== 'form' && !source.trim()" @click="addProvider">确定添加供应商</el-button>
    </template>
  </el-dialog>
  <component v-if="providerAgentDialog" :is="providerAgentDialog" v-model="agentVisible" :askUserEnabled="askUserEnabled" @generated="useGeneratedSource" />
</template>

<script setup lang="ts">
import axios from "axios";
import { computed, defineAsyncComponent, onBeforeUnmount, reactive, ref, shallowRef, watch, type Component } from "vue";
import formCreate, { type Api, type Options } from "../../formCreate";
import { IconFileCode, IconCode, IconFolderOpen, IconCopy, IconSparkles, IconForms, IconPlus, IconTrash, IconDownload } from "@tabler/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { mediaProviders } from "@toonflow/providers";
import { modelIcon } from "@toonflow/model-icons";
import messageMarkdown from "@/components/messageMarkdown.vue";
import { invalidateNodeModels } from "@toonflow/nodes-scaffold/nodeAi";
import tfRouterSource from "@toonflow/providers/media/tfRouter?raw";
import apiMartSource from "@toonflow/providers/media/apiMart?raw";
import metasoSource from "@toonflow/providers/media/metaso?raw";
import compshareSource from "@toonflow/providers/media/compshare?raw";
import type { MediaProvider } from "./types";
import { providerPrompt } from "./providerPrompt";
import { modelChoices, saveSettings } from "@/stores/settings";
import { writeClipboardText } from "@/lib/clipboard";
import { isMobile } from "@/lib/platform";

const { mode = "custom" } = defineProps<{ mode?: "builtin" | "custom" }>();
const visible = defineModel<boolean>({ default: false });
const emit = defineEmits<{ added: [provider: MediaProvider] }>();
const providerSources: Record<string, string> = { tfRouter: tfRouterSource, apiMart: apiMartSource, metaso: metasoSource, compshare: compshareSource };
const selectedProvider = ref<string>(mediaProviders[0]?.id ?? "");
const activeProvider = computed(() => mediaProviders.find(provider => provider.id === selectedProvider.value));
const models = computed<MediaProvider["models"]>(() => activeProvider.value?.models ?? []);
const providerReadme = computed(() => {
  const provider = activeProvider.value;
  return provider && "readme" in provider && typeof provider.readme === "string" ? provider.readme : "";
});
const activeTab = ref<"form" | "file" | "code">("form");
const addMethods = [
  { label: "手动配置", value: "form", icon: IconForms },
  { label: "文件导入", value: "file", icon: IconFileCode },
  { label: "粘贴代码", value: "code", icon: IconCode },
];

/** 声明式表单：提交后由宿主生成供应商源码，用户不写代码。 */
type DeclarativeModel = { id: string; label: string; type: "image" | "video" };
type DeclarativeChannel = { capability: "image" | "video"; protocol: string; models: DeclarativeModel[] };
const declarative = reactive<{ id: string; label: string; apiUrl: string; apiKey: string; channels: DeclarativeChannel[] }>({
  id: "", label: "", apiUrl: "", apiKey: "",
  channels: [{ capability: "image", protocol: "openai-images", models: [] }],
});
const protocolOptions = [
  { value: "openai-images", label: "OpenAI Images（/v1/images/generations）", capability: "image" },
  { value: "openai-videos", label: "OpenAI Videos（/v1/videos）", capability: "video" },
] as const;
const protocolsFor = (capability: "image" | "video") => protocolOptions.filter(item => item.capability === capability);
const declarativeModels = ref<(DeclarativeModel & { type: "image" | "video" })[]>([]);
const selectedModelIds = ref<Set<string>>(new Set());
const fetchingModels = ref(false);

function resetDeclarative() {
  Object.assign(declarative, { id: "", label: "", apiUrl: "", apiKey: "" });
  declarative.channels = [{ capability: "image", protocol: "openai-images", models: [] }];
  declarativeModels.value = [];
  selectedModelIds.value = new Set();
}
function addChannel() {
  const used = new Set(declarative.channels.map(item => item.capability));
  const capability = used.has("image") ? "video" : "image";
  declarative.channels.push({ capability, protocol: capability === "image" ? "openai-images" : "openai-videos", models: [] });
}
function removeChannel(index: number) {
  if (declarative.channels.length <= 1) return;
  declarative.channels.splice(index, 1);
}
function addManualModel() {
  ElMessageBox.prompt("模型 ID", "手动添加模型", { inputPlaceholder: "如 gpt-image-2.5", confirmButtonText: "添加", cancelButtonText: "取消" })
    .then(({ value }: { value: string }) => {
      const id = (value ?? "").trim();
      if (!id) return;
      declarativeModels.value.push({ id, label: id, type: "image" });
      selectedModelIds.value.add(id);
      syncModels();
    })
    .catch(() => {});
}
function toggleModel(model: DeclarativeModel) {
  if (selectedModelIds.value.has(model.id)) selectedModelIds.value.delete(model.id);
  else selectedModelIds.value.add(model.id);
  selectedModelIds.value = new Set(selectedModelIds.value);
  syncModels();
}
/** 勾选的模型按当前通道能力落到对应通道。 */
function syncModels() {
  const picked = declarativeModels.value.filter(model => selectedModelIds.value.has(model.id));
  for (const channel of declarative.channels) {
    channel.models = picked.map(model => ({ id: model.id, label: model.label || model.id, type: channel.capability }));
  }
}
async function fetchDeclarativeModels() {
  if (fetchingModels.value) return;
  fetchingModels.value = true;
  formError.value = "";
  try {
    const { data } = await axios.post("/api/providers/declarative/models", { apiUrl: declarative.apiUrl.trim(), apiKey: declarative.apiKey.trim() }, { timeout: 40000 });
    if (data.code !== 200 || !Array.isArray(data.data)) throw new Error(data.message || "获取模型列表失败");
    const list = (data.data as { id: string; label?: string; type?: string }[])
      .filter(item => typeof item.id === "string" && item.id.trim())
      .map(item => ({ id: item.id.trim(), label: (item.label ?? item.id).trim(), type: item.type === "video" ? "video" : "image" as const }));
    if (!list.length) throw new Error("接口未返回可用模型");
    declarativeModels.value = list;
    selectedModelIds.value = new Set(list.map(item => item.id));
    syncModels();
  } catch (error) {
    formError.value = axios.isAxiosError(error) ? error.response?.data?.message || error.message : error instanceof Error ? error.message : "获取模型列表失败";
  } finally {
    fetchingModels.value = false;
  }
}
const promptExpanded = ref(false);
const code = ref("");
const fileSource = ref("");
const fileName = ref("");
const fileInput = ref<HTMLInputElement>();
const saving = ref(false);
const openingAgent = ref(false);
const agentVisible = ref(false);
const askUserEnabled = ref(false);
const providerAgentDialog = shallowRef<Component>();
let agentOpening: AbortController | undefined;
const formError = ref("");
const formApi = shallowRef<Api>();
const addedProvider = shallowRef<MediaProvider>();
const formOptions = computed<Options>(() => ({ form: { labelPosition: "top", disabled: saving.value }, submitBtn: false, resetBtn: false }));
const providerRules = computed(() => formCreate.copyRules([...(activeProvider.value?.rules ?? [])]));
const source = computed(() => mode === "builtin" ? providerSources[selectedProvider.value] ?? "" : activeTab.value === "file" ? fileSource.value : code.value);

watch([activeTab, selectedProvider], () => {
  formError.value = "";
  addedProvider.value = undefined;
});

watch(visible, value => {
  agentOpening?.abort();
  agentOpening = undefined;
  openingAgent.value = false;
  if (!value) { agentVisible.value = false; return; }
  selectedProvider.value = mediaProviders[0]?.id ?? "";
  activeTab.value = "file";
  promptExpanded.value = false;
  formApi.value = undefined;
  addedProvider.value = undefined;
  code.value = fileSource.value = fileName.value = formError.value = "";
  resetDeclarative();
});

async function openAgent() {
  if (openingAgent.value || saving.value || !modelChoices.value.length) return;
  openingAgent.value = true;
  formError.value = "";
  const controller = new AbortController();
  agentOpening = controller;
  try {
    const { data } = await axios.get<{ data: { tools: { name: string; enabled: boolean; loadError?: string }[] } }>("/api/tools/get", { signal: controller.signal });
    if (controller.signal.aborted || !visible.value) return;
    const browser = data.data.tools.find(tool => tool.name === "browser");
    if (!browser?.enabled) throw new Error("请先在「工具市场」安装并启用网页浏览器工具");
    if (browser.loadError) throw new Error(`浏览器工具加载失败：${browser.loadError}`);
    askUserEnabled.value = data.data.tools.some(tool => tool.name === "askUser" && tool.enabled && !tool.loadError);
    providerAgentDialog.value ??= defineAsyncComponent(() => import("./providerAgentDialog.vue"));
    agentVisible.value = true;
  } catch (error) {
    if (controller.signal.aborted) return;
    formError.value = axios.isAxiosError(error) ? error.response?.data?.message || error.message : error instanceof Error ? error.message : "打开生成助手失败";
  } finally { if (agentOpening === controller) { agentOpening = undefined; openingAgent.value = false; } }
}

onBeforeUnmount(() => agentOpening?.abort());

function useGeneratedSource(source: string) {
  activeTab.value = "code";
  code.value = source;
  formError.value = "";
  addedProvider.value = undefined;
}

async function readSourceFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  formError.value = "";
  try {
    if (!/\.ts$/i.test(file.name) || file.size > 1024 * 1024) throw new Error("请选择不超过 1 MB 的 .ts 文件");
    fileSource.value = await file.text();
    fileName.value = file.name;
  } catch (error) {
    fileSource.value = fileName.value = "";
    formError.value = error instanceof Error ? error.message : "读取文件失败";
  }
}

async function addProvider() {
  if (saving.value) return;
  const useForm = mode !== "builtin" && activeTab.value === "form";
  if (!useForm && !source.value.trim()) return;
  if (mode === "builtin" && !formApi.value) return;
  saving.value = true;
  formError.value = "";
  try {
    if (useForm) {
      // ACT: 表单模式由宿主生成供应商源码，复用 media/add 全链路。
      const payload = {
        id: declarative.id.trim(), label: declarative.label.trim(), apiUrl: declarative.apiUrl.trim(),
        channels: declarative.channels.map(channel => ({
          capability: channel.capability, protocol: channel.protocol,
          models: declarativeModels.value.filter(model => selectedModelIds.value.has(model.id))
            .map(model => ({ id: model.id, label: model.label || model.id, type: channel.capability })),
        })).filter(channel => channel.models.length),
      };
      if (!payload.id || !payload.label || !payload.apiUrl) throw new Error("请填写供应商 ID、显示名称和 API 地址");
      if (!payload.channels.length) throw new Error("请至少勾选一个模型");
      const { data } = await axios.post("/api/providers/declarative/create", payload);
      if (data.code !== 200) throw new Error(data.message || "创建供应商失败");
      const created = data.data as MediaProvider;
      addedProvider.value = created;
      emit("added", created);
      if (declarative.apiKey.trim()) {
        await saveSettings(settings => {
          const configs = settings.mediaProviderConfigs as Record<string, Record<string, unknown>> | undefined;
          return { mediaProviderConfigs: { ...configs, [created.id]: { ...(configs?.[created.id] ?? {}), apiKey: declarative.apiKey.trim() } } };
        });
      }
      invalidateNodeModels("media");
      visible.value = false;
      return;
    }
    let values: Record<string, unknown> | undefined;
    if (mode === "builtin") {
      if (!(await formApi.value!.validate().then(() => true, () => false))) return;
      values = formApi.value!.formData();
      if ("apiKey" in values) {
        values.apiKey = typeof values.apiKey === "string" ? values.apiKey.trim() : "";
        if (!values.apiKey) throw new Error("请填写 API Key");
        if ((values.apiKey as string).length > 8192) throw new Error("API Key 过长");
      }
    }
    if (!addedProvider.value) {
      const { data } = await axios.post<{ data: MediaProvider }>("/api/providers/media/add", { source: source.value });
      addedProvider.value = data.data;
      emit("added", data.data);
      invalidateNodeModels("media");
    }
    if (values) {
      const providerId = addedProvider.value.id;
      // ACT: 安装成功但配置保存失败时保留安装结果，重试只保存配置。
      await saveSettings(settings => {
        const configs = settings.mediaProviderConfigs as Record<string, Record<string, unknown>> | undefined;
        if (configs !== undefined && (!configs || typeof configs !== "object" || Array.isArray(configs))) throw new Error("媒体供应商配置格式无效");
        const current = configs?.[providerId];
        if (current !== undefined && (!current || typeof current !== "object" || Array.isArray(current))) throw new Error("当前供应商配置格式无效");
        return { mediaProviderConfigs: { ...configs, [providerId]: { ...current, ...values } } };
      });
    }
    invalidateNodeModels("media");
    visible.value = false;
  } catch (error) {
    const message = axios.isAxiosError(error) ? error.response?.data?.message || error.message : error instanceof Error ? error.message : "添加失败，请重试";
    formError.value = addedProvider.value ? `供应商已添加，连接配置未保存：${message}。填写内容已保留，请重试。` : message;
  } finally {
    saving.value = false;
  }
}

async function copyPrompt() {
  try {
    await writeClipboardText(providerPrompt);
    ElMessage.success("提示词已复制，发给其他 AI 后跟着回答问题即可");
  } catch {
    ElMessage.error("复制失败，请展开「查看完整提示词」后手动复制");
  }
}
</script>

<style lang="scss" scoped>
.providerPicker {
  display: grid;
  grid-template-columns: 180px minmax(0, 1fr);
  height: min(560px, 70dvh);
  gap: 24px;

  .providerSidebar {
    overflow-y: auto;
    border-right: 1px solid var(--el-border-color-lighter);
    padding: 2px;

    .providerItem {
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      padding: 10px 12px;
      margin-bottom: 4px;
      border: 0;
      border-radius: var(--el-border-radius-base);
      background: transparent;
      color: var(--el-text-color-regular);
      font: inherit;
      text-align: left;
      cursor: pointer;

      &:hover { background: var(--el-fill-color-light); }
      &[aria-pressed="true"] {
        background: var(--el-color-primary-light-9);
        color: var(--el-color-primary);
      }
      &:focus-visible { outline: 2px solid var(--el-color-primary); }

      .providerLogo {
        width: 18px;
        height: 18px;
        object-fit: contain;

        &.monochrome {
          .dark & { filter: invert(1); }
        }
      }
    }
  }

  .providerDetails {
    min-width: 0;

    .providerContent {
      padding-right: 12px;

      .providerHeader {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 10px;
        margin: 4px 0 24px;

        h3 {
          margin: 0;
          color: var(--el-text-color-primary);
          font-size: 18px;
          overflow-wrap: anywhere;
        }
      }
      .providerReadme {
        margin-bottom: 24px;
        overflow-wrap: anywhere;
      }
      .modelHeader {
        margin: 8px 0 12px;
      }
      .modelList {
        margin-bottom: 16px;
      }
    }
  }

  @media (max-width: 600px) {
    grid-template-columns: 1fr;
    grid-template-rows: auto minmax(0, 1fr);
    gap: 16px;

    .providerSidebar {
      max-height: 128px;
      border-right: 0;
      border-bottom: 1px solid var(--el-border-color-lighter);
    }
  }
}

.dialogContent {
  padding: 8px 4px;

  .importForm {
    .methodField {
      .methodOption {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        padding: 4px 0;
      }
    }

    .sourceField {
      margin-bottom: 0;

      .fileImport {
        width: 100%;

        .fileSource {
          display: flex;
          width: 100%;
          gap: 8px;

          .el-input { min-width: 0; }
          .el-button { flex-shrink: 0; }
        }

        .fieldHint {
          display: block;
          margin-top: 6px;
          line-height: 1.5;
        }
      }

      .sourceInput :deep(.el-textarea__inner) {
        height: min(28dvh, 240px);
        min-height: 140px;
        padding: 12px;
        font-family: "Cascadia Code", "SFMono-Regular", Consolas, monospace;
        font-size: 13px;
        line-height: 1.7;
      }
    }
  }

  .providerTips {
    margin-top: 24px;
    padding-top: 20px;
    border-top: 1px solid var(--el-border-color-lighter);

    h4 {
      margin: 0;
      color: var(--el-text-color-primary);
    }

    p {
      margin: 8px 0 12px;
      color: var(--el-text-color-secondary);
      font-size: 13px;
      line-height: 1.6;
    }

    .assistantActions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;

      .el-button { margin-left: 0; }
    }

    .fieldHint {
      display: block;
      margin-top: 8px;
      line-height: 1.5;
    }

    .promptDetails {
      margin-top: 12px;

      summary {
        width: fit-content;
        color: var(--el-text-color-secondary);
        font-size: 12px;
        line-height: 20px;
        cursor: pointer;

        &:hover { color: var(--el-color-primary); }
        &:focus-visible {
          outline: 2px solid var(--el-color-primary);
          outline-offset: 4px;
          border-radius: var(--el-border-radius-small);
        }
      }

      .el-textarea {
        margin-top: 12px;

        :deep(.el-textarea__inner) {
          padding: 12px;
          font-size: 12px;
          line-height: 1.7;
        }
      }
    }
  }


  .declarativeForm {
    .formRow {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0 16px;
    }

    .channelList {
      width: 100%;

      .channelRow {
        display: flex;
        gap: 8px;
        align-items: center;
        margin-bottom: 8px;
      }

      .channelCapability { width: 108px; flex: none; }
      .channelProtocol { flex: 1 1 auto; min-width: 0; }
    }

    .modelTools {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 8px;
    }

    .modelChips {
      display: flex;
      flex-wrap: wrap;
      gap: 4px 16px;
      max-height: 168px;
      overflow-y: auto;
    }
  }

  .formError {
    margin-top: 16px;
  }

  @media (max-width: 560px) {
    .importForm .sourceField .fileImport .fileSource {
      flex-direction: column;

      .el-button { align-self: flex-start; }
    }

    .providerTips .assistantActions {
      .el-button { flex: 1 1 180px; }
    }
  }
}
</style>
