// AdDroid OSS — OpenAI ImageProvider.
//
// Uses the OpenAI API key already stored by `addroid auth llm --provider openai`.
// The key remains encrypted in oauth_tokens and is decrypted only inside
// generateImage(). GPT Image models return base64 image data, so the adapter
// normalizes provider output to bytes and never exposes an external URL.

import { createHash } from "node:crypto";

import { redactPayloadForError } from "./redact.js";
import type { ApiKeyCryptoBoundary } from "./api-key.js";
import type { LLMProviderTokenStore } from "./token-store.js";
import {
  ImageProviderError,
  ImageProviderInvalidRequestError,
  ImageProviderNotConfiguredError,
  validateImageGenerateRequest,
  type ImageGenerateRequest,
  type ImageGenerateResult,
  type ImageGeneratedAsset,
  type ImageProvider,
  type ImageProviderName,
  type ImageVariationCondition,
} from "./image-provider.js";

export interface OpenAIImageProviderOptions {
  tokenStore: LLMProviderTokenStore;
  crypto: ApiKeyCryptoBoundary;
  /** Defaults to the current OpenAI GPT Image 2 model id. */
  defaultModel?: string;
  /** Defaults to https://api.openai.com/v1/images/generations. */
  imagesGenerationsUrl?: string | null;
  /** Defaults to https://api.openai.com/v1/images/edits. Used when referenceImages are supplied. */
  imagesEditsUrl?: string | null;
  /** Defaults to medium. */
  quality?: "low" | "medium" | "high" | "auto";
  fetchImpl?: typeof fetch;
}

const DEFAULT_MODEL = "gpt-image-2";
const DEFAULT_IMAGES_GENERATIONS_URL =
  "https://api.openai.com/v1/images/generations";
const DEFAULT_IMAGES_EDITS_URL = "https://api.openai.com/v1/images/edits";

export class OpenAIImageProvider implements ImageProvider {
  readonly name: ImageProviderName = "openai";
  readonly defaultModel: string;
  readonly enabled = true;

  private readonly tokenStore: LLMProviderTokenStore;
  private readonly crypto: ApiKeyCryptoBoundary;
  private readonly imagesGenerationsUrl: string;
  private readonly imagesEditsUrl: string;
  private readonly quality: "low" | "medium" | "high" | "auto";
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OpenAIImageProviderOptions) {
    this.tokenStore = opts.tokenStore;
    this.crypto = opts.crypto;
    this.defaultModel = opts.defaultModel?.trim() || DEFAULT_MODEL;
    this.imagesGenerationsUrl =
      opts.imagesGenerationsUrl?.trim() || DEFAULT_IMAGES_GENERATIONS_URL;
    this.imagesEditsUrl = opts.imagesEditsUrl?.trim() || DEFAULT_IMAGES_EDITS_URL;
    this.quality = opts.quality ?? "medium";
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async generateImage(req: ImageGenerateRequest): Promise<ImageGenerateResult> {
    validateImageGenerateRequest(this.name, req);
    const model = req.model?.trim() || this.defaultModel;
    const normalizedConditions = normalizeVariationConditions(req);
    validateOpenAIConditions(this.name, normalizedConditions);

    const record = await this.tokenStore.loadOAuthToken("openai");
    if (!record) {
      throw new ImageProviderNotConfiguredError(this.name, "generateImage");
    }
    const apiKey = this.crypto.decrypt(record.accessTokenCiphertext);

    const generatedAt = new Date().toISOString();
    const requestIds: string[] = [];
    const assets: ImageGeneratedAsset[] = [];

    // OpenAI gpt-image は 1024x1024 / 1536x1024 / 1024x1536 のみ許可 (各辺 16 の倍数)。
    // 広告用ネイティブ寸法 (1080x1080 等) はそのままだと (#) invalid size で弾かれるため、
    // 最寄りのアスペクト比の許可サイズにスナップして生成する (下流で配置寸法へリサイズ)。
    const snapToOpenAISize = (w: number, h: number): string => {
      const ratio = w / h;
      if (ratio > 1.2) return "1536x1024";
      if (ratio < 0.83) return "1024x1536";
      return "1024x1024";
    };

    for (const cond of normalizedConditions) {
      const prompt = buildPrompt(req.prompt, cond);
      const response = req.referenceImages?.length
        ? await this.callOpenAIEdit({
            apiKey,
            model,
            prompt,
            size: snapToOpenAISize(cond.width, cond.height),
            outputFormat: cond.format ?? "png",
            referenceImages: req.referenceImages,
          })
        : await this.callOpenAI({
            apiKey,
            model,
            prompt,
            size: snapToOpenAISize(cond.width, cond.height),
            outputFormat: cond.format ?? "png",
          });
      if (response.requestId) requestIds.push(response.requestId);
      assets.push({
        variantKey: cond.variantKey!,
        bytes: response.bytes,
        mimeType: response.mimeType,
        width: cond.width,
        height: cond.height,
        byteSize: response.bytes.byteLength,
      });
    }

    return {
      assets,
      meta: {
        provider: this.name,
        model,
        requestId: requestIds.length > 0 ? requestIds.join(",") : null,
        generatedAt,
        prompt: req.prompt,
        parameters: {
          variationConditions: normalizedConditions,
          purpose: req.purpose ?? null,
          variantCount: normalizedConditions.length,
          referenceImageCount: req.referenceImages?.length ?? 0,
        },
        qaResult: null,
      },
      costUsd: 0,
    };
  }

  private async callOpenAIEdit(params: {
    apiKey: string;
    model: string;
    prompt: string;
    size: string;
    outputFormat: "png" | "jpeg";
    referenceImages: NonNullable<ImageGenerateRequest["referenceImages"]>;
  }): Promise<{
    bytes: Uint8Array;
    mimeType: "image/png" | "image/jpeg";
    requestId: string | null;
  }> {
    const form = new FormData();
    form.set("model", params.model);
    form.set("prompt", params.prompt);
    form.set("size", params.size);
    form.set("quality", this.quality);
    form.set("output_format", params.outputFormat);
    form.set("n", "1");
    for (let i = 0; i < params.referenceImages.length; i += 1) {
      const ref = params.referenceImages[i]!;
      const filename = ref.filename?.trim() || `reference-${i}${extensionForMime(ref.mimeType)}`;
      const bytes = ref.bytes.buffer.slice(
        ref.bytes.byteOffset,
        ref.bytes.byteOffset + ref.bytes.byteLength
      ) as ArrayBuffer;
      form.append(
        "image",
        new Blob([bytes], { type: ref.mimeType }),
        filename
      );
    }

    let res: Response;
    try {
      res = await this.fetchImpl(this.imagesEditsUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${params.apiKey}`,
        },
        body: form,
      });
    } catch (err) {
      throw new ImageProviderError(
        this.name,
        `failed to reach image edits endpoint: ${redactPayloadForError((err as Error).message).replaceAll(params.apiKey, "[REDACTED]")}`
      );
    }

    return this.parseOpenAIImageResponse(res, params.outputFormat, params.apiKey);
  }

  private async callOpenAI(params: {
    apiKey: string;
    model: string;
    prompt: string;
    size: string;
    outputFormat: "png" | "jpeg";
  }): Promise<{
    bytes: Uint8Array;
    mimeType: "image/png" | "image/jpeg";
    requestId: string | null;
  }> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.imagesGenerationsUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${params.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: params.model,
          prompt: params.prompt,
          size: params.size,
          quality: this.quality,
          output_format: params.outputFormat,
          n: 1,
        }),
      });
    } catch (err) {
      throw new ImageProviderError(
        this.name,
        `failed to reach image endpoint: ${redactPayloadForError((err as Error).message).replaceAll(params.apiKey, "[REDACTED]")}`
      );
    }

    return this.parseOpenAIImageResponse(res, params.outputFormat, params.apiKey);
  }

  private async parseOpenAIImageResponse(
    res: Response,
    outputFormat: "png" | "jpeg",
    apiKey: string
  ): Promise<{
    bytes: Uint8Array;
    mimeType: "image/png" | "image/jpeg";
    requestId: string | null;
  }> {
    const requestId = res.headers.get("x-request-id");
    const text = await res.text();
    const json = parseJson(text);
    if (!res.ok) {
      const errorObj =
        json && typeof json === "object" && "error" in json
          ? (json as { error?: { message?: unknown; code?: unknown; type?: unknown } }).error
          : null;
      const rawMessage =
        typeof errorObj?.message === "string"
          ? errorObj.message
          : `image generation error (${res.status})`;
      const rawCode =
        typeof errorObj?.code === "string"
          ? errorObj.code
          : typeof errorObj?.type === "string"
            ? errorObj.type
            : undefined;
      throw new ImageProviderError(
        this.name,
        redactPayloadForError(rawMessage).replaceAll(apiKey, "[REDACTED]"),
        {
          status: res.status,
          ...(rawCode
            ? { code: redactPayloadForError(rawCode).replaceAll(apiKey, "[REDACTED]") }
            : {}),
          payload: redactPayloadForError(text).replaceAll(apiKey, "[REDACTED]"),
        }
      );
    }

    const item = extractFirstImage(json);
    if (item.b64_json) {
      const bytes = decodeBase64Image(item.b64_json);
      return {
        bytes,
        mimeType: outputFormat === "jpeg" ? "image/jpeg" : "image/png",
        requestId,
      };
    }
    if (item.url) {
      const fetched = await this.fetchImageUrl(item.url, apiKey);
      return { ...fetched, requestId };
    }
    throw new ImageProviderError(this.name, "image response did not contain image data", {
      status: res.status,
      payload: redactPayloadForError(text).replaceAll(apiKey, "[REDACTED]"),
    });
  }

  private async fetchImageUrl(
    url: string,
    apiKey: string
  ): Promise<{ bytes: Uint8Array; mimeType: "image/png" | "image/jpeg" }> {
    let res: Response;
    try {
      res = await this.fetchImpl(url);
    } catch (err) {
      throw new ImageProviderError(
        this.name,
        `failed to fetch image bytes: ${redactPayloadForError((err as Error).message).replaceAll(apiKey, "[REDACTED]")}`
      );
    }
    if (!res.ok) {
      throw new ImageProviderError(this.name, `failed to fetch image bytes (${res.status})`, {
        status: res.status,
      });
    }
    const contentType = res.headers.get("content-type")?.toLowerCase() ?? "";
    const mimeType = contentType.includes("jpeg") || contentType.includes("jpg")
      ? "image/jpeg"
      : "image/png";
    return {
      bytes: new Uint8Array(await res.arrayBuffer()),
      mimeType,
    };
  }
}

function normalizeVariationConditions(req: ImageGenerateRequest): ImageVariationCondition[] {
  return req.variationConditions.map((cond, idx) => {
    const out: ImageVariationCondition = {
      width: cond.width,
      height: cond.height,
      format: cond.format ?? "png",
      variantKey: cond.variantKey ?? `variant-${idx}`,
    };
    if (cond.styleNotes !== undefined) out.styleNotes = cond.styleNotes;
    if (cond.negativePrompt !== undefined) out.negativePrompt = cond.negativePrompt;
    return out;
  });
}

function validateOpenAIConditions(
  providerName: ImageProviderName,
  conditions: ImageVariationCondition[]
): void {
  for (let i = 0; i < conditions.length; i += 1) {
    const cond = conditions[i]!;
    if (cond.width > 3840 || cond.height > 3840) {
      throw new ImageProviderInvalidRequestError(
        providerName,
        `variationConditions[${i}] exceeds gpt-image-2 maximum edge length of 3840px`
      );
    }
  }
}

function buildPrompt(basePrompt: string, cond: ImageVariationCondition): string {
  const parts = [basePrompt.trim()];
  if (cond.styleNotes?.trim()) {
    parts.push(`Style notes: ${cond.styleNotes.trim()}`);
  }
  if (cond.negativePrompt?.trim()) {
    parts.push(`Avoid: ${cond.negativePrompt.trim()}`);
  }
  return parts.join("\n\n");
}

function extensionForMime(mimeType: "image/png" | "image/jpeg" | "image/webp"): string {
  if (mimeType === "image/jpeg") return ".jpg";
  if (mimeType === "image/webp") return ".webp";
  return ".png";
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractFirstImage(json: unknown): { b64_json?: string; url?: string } {
  if (!json || typeof json !== "object") {
    throw new ImageProviderError("openai", "image response was not JSON");
  }
  const data = (json as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length === 0 || !data[0] || typeof data[0] !== "object") {
    throw new ImageProviderError("openai", "image response did not contain data[0]");
  }
  const first = data[0] as { b64_json?: unknown; url?: unknown };
  const out: { b64_json?: string; url?: string } = {};
  if (typeof first.b64_json === "string" && first.b64_json.length > 0) {
    out.b64_json = first.b64_json;
  }
  if (typeof first.url === "string" && first.url.length > 0) {
    out.url = first.url;
  }
  return out;
}

function decodeBase64Image(value: string): Uint8Array {
  try {
    return new Uint8Array(Buffer.from(value, "base64"));
  } catch {
    const id = createHash("sha256").update(value).digest("hex").slice(0, 12);
    throw new ImageProviderError("openai", `invalid base64 image payload (${id})`);
  }
}
