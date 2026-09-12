import { z } from 'zod';

export const modelProtocolSchema = z.enum(['responses', 'chat-completions']);
export type ModelProtocol = z.infer<typeof modelProtocolSchema>;
export const modelCapabilitySchema = z.enum(['text', 'vision', 'tools', 'streaming']);
export type ModelCapability = z.infer<typeof modelCapabilitySchema>;
export const credentialModeSchema = z.enum(['windows', 'session', 'none']);
export type CredentialMode = z.infer<typeof credentialModeSchema>;
export const capabilityResultSchema = z.object({
  status: z.enum(['unknown', 'supported', 'unsupported', 'error']),
  checkedAt: z.string().datetime().nullable(), message: z.string().max(1000),
}).strict();
export type CapabilityResult = z.infer<typeof capabilityResultSchema>;
export const modelCapabilitiesSchema = z.object({ text: capabilityResultSchema, vision: capabilityResultSchema, tools: capabilityResultSchema, streaming: capabilityResultSchema }).strict();
export type ModelCapabilities = z.infer<typeof modelCapabilitiesSchema>;

/** The only protocols supported by a custom URL are the two compatible wire formats. */
export function normalizeModelUrl(raw: string, protocol: ModelProtocol): { baseUrl: string; endpointUrl: string; modelsUrl: string } {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new Error('请输入完整的 http:// 或 https:// 服务地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) throw new Error('地址仅支持 HTTP/HTTPS，不能包含账号、密码、查询参数或锚点');
  let prefix = url.pathname.replace(/\/+$/, '').replace(/\/(responses|chat\/completions|models)$/i, '').replace(/\/+$/, '');
  // Preserve the service prefix exactly, including a root endpoint. Never guess an extra /v1.
  if (/\/(responses|chat\/completions|models)(\/|$)/i.test(prefix)) throw new Error('地址包含重复接口路径，请填写服务根地址或一个完整接口地址');
  const baseUrl = `${url.origin}${prefix}`;
  return { baseUrl, endpointUrl: `${baseUrl}/${protocol === 'responses' ? 'responses' : 'chat/completions'}`, modelsUrl: `${baseUrl}/models` };
}

export const modelProfileInputSchema = z.object({
  name: z.string().trim().min(1, '请填写配置名称').max(100),
  protocol: modelProtocolSchema,
  baseUrl: z.string().trim().min(1, '请填写服务地址').max(2000),
  model: z.string().trim().min(1, '请填写模型名称').max(200),
  timeoutMs: z.number().int().min(1000).max(600000).default(60000),
  maxOutputTokens: z.number().int().min(64).max(131072).default(4096),
  streamEnabled: z.boolean().default(false),
  credentialMode: credentialModeSchema.default('none'),
  apiKey: z.string().max(2500).optional(),
  clearKey: z.boolean().default(false),
}).strict().superRefine((input, ctx) => {
  try { normalizeModelUrl(input.baseUrl, input.protocol); }
  catch (error) { ctx.addIssue({ code: 'custom', path: ['baseUrl'], message: error instanceof Error ? error.message : '无效地址' }); }
  if (input.credentialMode === 'none' && input.apiKey?.trim()) ctx.addIssue({ code: 'custom', path: ['credentialMode'], message: '填写密钥后请选择 Windows 凭据或仅本次会话' });
  if (input.clearKey && input.apiKey?.trim()) ctx.addIssue({ code: 'custom', path: ['apiKey'], message: '清除密钥时请留空密钥输入框' });
});
export type ModelProfileInput = z.infer<typeof modelProfileInputSchema>;
export type ModelProfile = Omit<ModelProfileInput, 'apiKey' | 'clearKey'> & {
  id: string; endpointUrl: string; modelsUrl: string; keyPresent: boolean; isActive: boolean;
  capabilities: ModelCapabilities; createdAt: string; updatedAt: string;
};
export type ModelProfileList = { items: ModelProfile[]; activeId: string | null };
export type CredentialStatus = { windowsAvailable: boolean; defaultMode: CredentialMode; message: string };
export function unknownCapabilities(): ModelCapabilities {
  const unknown = () => ({ status: 'unknown' as const, checkedAt: null, message: '尚未验证' });
  return { text: unknown(), vision: unknown(), tools: unknown(), streaming: unknown() };
}

export type ModelTool = { name: string; description: string; parameters: Record<string, unknown> };
export type ModelToolDefinition = ModelTool;
export type ModelToolCall = { id: string; name: string; arguments: string };
export type ModelImage = { mediaId?: string; dataUrl: string; detail?: 'low' | 'high' | 'auto' };
export type ModelMessage = { role: 'user' | 'assistant' | 'tool'; text: string; images?: ModelImage[]; toolCalls?: ModelToolCall[]; callId?: string; providerItems?: unknown[] };
export type ModelUsage = { inputTokens?: number; outputTokens?: number; totalTokens?: number };
export type ModelRequest = {
  system: string; messages: ModelMessage[]; tools?: ModelTool[]; toolChoice?: 'auto' | 'required';
  stream?: boolean; signal?: AbortSignal; onDelta?: (text: string) => void;
  /** Refuse a changed endpoint/model/key while an already prepared task is executing. */
  expectedProfileUpdatedAt?: string;
};
export type ModelResult = { text: string; toolCalls: ModelToolCall[]; usage: ModelUsage | null; providerItems?: unknown[] };
