export type AiModelKind = 'vision';
export type AiModelRuntime = 'ollama' | 'api';

export interface AiModelManifest {
  id: string;
  displayName: string;
  kind: AiModelKind;
  runtime: AiModelRuntime;
  recommendedVramGb: number;
  installSize: string;
  licenseLabel: string;
  installerComponentId: string;
  description: string;
  ollamaModelName?: string;
  localModelPath?: string;
}

export const AI_VISION_MODELS: AiModelManifest[] = [
  {
    id: 'qwen25vl-7b-6g',
    displayName: 'Qwen2.5-VL 7B',
    kind: 'vision',
    runtime: 'ollama',
    recommendedVramGb: 6,
    installSize: '~5-6 GB',
    licenseLabel: 'Apache-2.0',
    installerComponentId: 'vision.qwen25vl7b',
    description: 'Lightweight vision understanding for documents and reference images',
    ollamaModelName: 'qwen2.5vl:7b'
  },
  {
    id: 'minicpm-v45-8g',
    displayName: 'MiniCPM-V 4.5',
    kind: 'vision',
    runtime: 'ollama',
    recommendedVramGb: 8,
    installSize: '~6-8 GB',
    licenseLabel: 'Verify before commercial release',
    installerComponentId: 'vision.minicpmv45',
    description: 'Enhanced vision understanding and Chinese image-text analysis',
    ollamaModelName: 'minicpm-v4.5'
  },
  {
    id: 'gemma3-12b-12g',
    displayName: 'Gemma 3 12B',
    kind: 'vision',
    runtime: 'ollama',
    recommendedVramGb: 12,
    installSize: '~8-9 GB',
    licenseLabel: 'Gemma Terms of Use',
    installerComponentId: 'vision.gemma312b',
    description: 'Higher quality visual reasoning and image Q&A',
    ollamaModelName: 'gemma3:12b'
  }
];

export const AI_MODEL_MANIFEST = [...AI_VISION_MODELS];
