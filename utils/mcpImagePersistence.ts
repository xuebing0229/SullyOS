import type { CharacterProfile, GalleryImage, Message } from '../types';
import { DB } from './db';
import { blobRefFromId, createImageBlobId } from './blobRef';
import { extractMcpImageCandidates, getMcpImageCandidateKey, type McpImageCandidate } from './mcpToolBridge';
import type { McpServerConfig, McpToolResult } from './mcpClient';
import {
    captureImageGenerationBilling,
    detectImageGenerationFeatureUsage,
    recordSuccessfulImageGeneration,
    type ImageGenerationBillingCapture,
} from './imageGenerationBilling';

export const MAX_MCP_IMAGE_BYTES = 25 * 1024 * 1024;
export interface PersistMcpImageInput {
    result: McpToolResult; char: CharacterProfile; server?: Pick<McpServerConfig, 'id' | 'name'>;
    toolName: string; toolArgs?: Record<string, any>; recentMessages?: Message[]; seenKeys?: Set<string>;
    extraMessageMetadata?: Record<string, unknown>; extraGallerySourceMeta?: Record<string, unknown>;
    allowTemporaryUrlFallback?: boolean;
    /** meeting-cg keeps the image out of the ordinary chat message store. */
    ownerType?: 'chat' | 'meeting-cg';
    imageBillingCapture?: ImageGenerationBillingCapture;
}
export interface PersistedMcpImageAsset {
    blobRef: string;
    galleryImageId: string;
    createdAt: number;
    engine?: string;
    prompt?: string;
}
export interface PersistMcpImageOutput { persisted: number; temporary: number; failed: number; errors: string[]; assets: PersistedMcpImageAsset[]; }

const base64ByteLength = (base64: string): number => {
    const clean = base64.replace(/\s+/g, '');
    const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
    return Math.max(0, Math.floor(clean.length * 3 / 4) - padding);
};
const decodeBase64Image = (data: string, mimeType: string): Blob => {
    const comma = data.indexOf(',');
    const payload = data.startsWith('data:') && comma >= 0 ? data.slice(comma + 1) : data;
    const clean = payload.replace(/\s+/g, '');
    const estimatedBytes = base64ByteLength(clean);
    if (estimatedBytes <= 0) throw new Error('MCP 返回了空图片');
    if (estimatedBytes > MAX_MCP_IMAGE_BYTES) throw new Error('图片超过 25 MB 本机持久化上限');
    const binary = atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mimeType.startsWith('image/') ? mimeType : 'image/png' });
};
const sniffImageMime = async (blob: Blob): Promise<string | null> => {
    const bytes = new Uint8Array(await blob.slice(0, 32).arrayBuffer());
    if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
    if (bytes.length >= 6 && String.fromCharCode(...bytes.slice(0, 6)).startsWith('GIF8')) return 'image/gif';
    if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return 'image/webp';
    if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(4, 8)) === 'ftyp') {
        const brand = String.fromCharCode(...bytes.slice(8, 12));
        if (brand === 'avif' || brand === 'avis') return 'image/avif';
    }
    return null;
};
const normalizeImageBlob = async (blob: Blob, declaredMime?: string): Promise<Blob> => {
    if (blob.size <= 0) throw new Error('图片内容为空');
    if (blob.size > MAX_MCP_IMAGE_BYTES) throw new Error(`图片大小 ${(blob.size / 1024 / 1024).toFixed(1)} MB，超过 25 MB 上限`);
    const declared = declaredMime?.startsWith('image/') ? declaredMime : blob.type.startsWith('image/') ? blob.type : '';
    const mime = (await sniffImageMime(blob)) || declared;
    if (!mime) throw new Error('返回内容不是可识别的图片');
    return blob.type === mime ? blob : new Blob([blob], { type: mime });
};
export const mcpImageCandidateToBlob = async (candidate: McpImageCandidate): Promise<Blob> => {
    if (candidate.kind === 'base64') return normalizeImageBlob(decodeBase64Image(candidate.data, candidate.mimeType), candidate.mimeType);
    const response = await fetch(candidate.url, { method: 'GET', cache: 'no-store', credentials: 'omit' });
    if (!response.ok) throw new Error(`下载图片失败：HTTP ${response.status}`);
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > MAX_MCP_IMAGE_BYTES) throw new Error('图片超过 25 MB 本机持久化上限');
    return normalizeImageBlob(await response.blob(), response.headers.get('content-type') || candidate.mimeType || '');
};
const extractPrompt = (args?: Record<string, any>): string | undefined => {
    for (const key of ['prompt','positive_prompt','positivePrompt','description','tags','input']) {
        const value=args?.[key]; if (typeof value === 'string' && value.trim()) return value.trim().slice(0,2000);
    }
};
const inferEngine = (toolName: string, serverName?: string): string | undefined => {
    const text=`${serverName||''} ${toolName}`.toLowerCase();
    if (text.includes('novel')) return 'NovelAI';
    if (text.includes('gpt') || text.includes('image')) return 'GPT Image';
    return serverName || undefined;
};
const buildRecentChatContext = (messages?: Message[]): string[] | undefined => messages?.slice(-8).map(message => {
    if (message.type === 'image') return `${message.role === 'user' ? '用户' : '角色'}：[图片]`;
    if (message.type === 'emoji') return `${message.role === 'user' ? '用户' : '角色'}：[表情]`;
    const text=typeof message.content === 'string' ? message.content.trim().slice(0,300) : '';
    return text ? `${message.role === 'user' ? '用户' : '角色'}：${text}` : '';
}).filter(Boolean) as string[] | undefined;

const saveTemporaryUrlMessage = async (candidate: Extract<McpImageCandidate,{kind:'url'}>, input: PersistMcpImageInput, error: unknown) => {
    const message=error instanceof Error ? error.message : String(error);
    await DB.saveMessage({ charId: input.char.id, role:'assistant', type:'image', content:candidate.url, metadata:{
        mcpGeneratedImage:true,persistedLocally:false,temporaryRemoteUrl:true,persistenceError:message,
        mcpServerId:input.server?.id,mcpServerName:input.server?.name,mcpToolName:input.toolName,
        imageEngine:inferEngine(input.toolName,input.server?.name),imagePrompt:extractPrompt(input.toolArgs),
        ...(input.extraMessageMetadata || {}),
    }} as any);
};

export async function persistMcpGeneratedImages(input: PersistMcpImageInput): Promise<PersistMcpImageOutput> {
    const candidates=extractMcpImageCandidates(input.result);
    const seenKeys=input.seenKeys ?? new Set<string>();
    const output:PersistMcpImageOutput={persisted:0,temporary:0,failed:0,errors:[],assets:[]};
    for (const candidate of candidates) {
        const key=getMcpImageCandidateKey(candidate); if (seenKeys.has(key)) continue; seenKeys.add(key);
        try {
            const blob=await mcpImageCandidateToBlob(candidate); const createdAt=Date.now();
            const blobId=createImageBlobId(); const blobRef=blobRefFromId(blobId); const galleryId=`gallery_mcp_${blobId}`;
            const prompt=extractPrompt(input.toolArgs); const engine=inferEngine(input.toolName,input.server?.name);
            const gallery:GalleryImage={ id:galleryId,charId:input.char.id,url:blobRef,timestamp:createdAt,
                savedDate:new Date(createdAt).toISOString().slice(0,10),chatContext:buildRecentChatContext(input.recentMessages),
                source:'mcp-generated',sourceMeta:{serverId:input.server?.id,serverName:input.server?.name,toolName:input.toolName,engine,prompt,originalUrl:candidate.kind==='url'?candidate.url:undefined,...(input.extraGallerySourceMeta || {})} };
            if (input.ownerType === 'meeting-cg') {
                await DB.saveGeneratedImageAssetBundle({ blobId, blob, createdAt, gallery });
            } else {
                await DB.saveGeneratedImageBundle({blobId,blob,createdAt,gallery,message:{charId:input.char.id,role:'assistant',type:'image',content:blobRef,metadata:{
                    mcpGeneratedImage:true,persistedLocally:true,galleryImageId:galleryId,mcpServerId:input.server?.id,mcpServerName:input.server?.name,
                    mcpToolName:input.toolName,imageEngine:engine,imagePrompt:prompt,originalRemoteUrl:candidate.kind==='url'?candidate.url:undefined,
                    ...(input.extraMessageMetadata || {}),
                }} as any});
            }
            output.assets.push({ blobRef, galleryImageId: galleryId, createdAt, engine, prompt });
            output.persisted++;
        } catch(error) {
            const message=error instanceof Error?error.message:String(error); output.errors.push(message);
            if(input.ownerType !== 'meeting-cg' && candidate.kind==='url' && input.allowTemporaryUrlFallback !== false) { try { await saveTemporaryUrlMessage(candidate,input,error); output.temporary++; continue; } catch(e) { output.errors.push(e instanceof Error?e.message:String(e)); } }
            output.failed++;
        }
    }
    if (output.persisted > 0 || output.temporary > 0) {
        const engineId = input.server?.id === 'builtin_image_novelai' || input.toolName === 'novelai_generate_image'
            ? 'novelai'
            : input.server?.id === 'builtin_image_gpt-image' || input.toolName === 'generate_image'
                ? 'gpt-image'
                : null;
        if (engineId) {
            const structured = input.result.structuredContent && typeof input.result.structuredContent === 'object'
                ? input.result.structuredContent as Record<string, any>
                : {};
            const requestId = String(structured.requestId || structured.correlationId || `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
            const model = String(structured.model || input.toolArgs?.model || engineId);
            try {
                await recordSuccessfulImageGeneration({
                    capture: input.imageBillingCapture || captureImageGenerationBilling(engineId),
                    requestId,
                    model,
                    featureUsage: detectImageGenerationFeatureUsage(input.toolArgs),
                    charId: input.char.id,
                    charName: input.char.name,
                });
            } catch (error) {
                // 费用统计是 best-effort，落账失败不能把已经成功保存的图片反判为失败。
                console.warn('[image billing] failed to record successful generation', error);
            }
        }
    }
    return output;
}
