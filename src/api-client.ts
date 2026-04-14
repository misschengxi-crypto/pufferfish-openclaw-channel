import type { PufferfishAccount, SendMessageRequest, SendMessageResponse } from './types.js';
import crypto from 'crypto';

/**
 * Pufferfish API 客户端
 * 负责与 Pufferfish 服务器的 HTTP API 通信
 */
export class PufferfishAPIClient {
  private baseURL: string;      // API 基础URL
  private token: string;         // JWT 认证令牌
  private botUserId: number;     // 机器人用户ID

  constructor(account: PufferfishAccount) {
    this.baseURL = PufferfishAPIClient.normalizeBaseUrl(account.apiUrl);
    this.token = account.token;
    this.botUserId = account.botUserId ?? 0;
  }

  /** 兼容 apiUrl 为 https://host/v1/ */
  static normalizeBaseUrl(apiUrl: string): string {
    let url = String(apiUrl ?? '').trim().replace(/\/+$/, '');
    if (url.endsWith('/v1')) url = url.slice(0, -3);
    return url;
  }

  /** 反代 TLS 终止时，服务端可能返回 ws://；若 apiUrl 是 https://，这里自动提升为 wss://。 */
  static normalizeWsUrl(apiUrl: string, wsUrl: string): string {
    const ws = String(wsUrl ?? '').trim();
    if (!ws) return ws;
    try {
      const u = new URL(ws);
      const host = u.hostname.toLowerCase();
      const isLocal =
        host === 'localhost' ||
        host === '127.0.0.1' ||
        host === '::1';
      if (u.protocol === 'ws:' && !isLocal) {
        u.protocol = 'wss:';
      }
      return u.toString();
    } catch {
      // 保持原值，避免因非法 URL 影响既有行为
      return ws;
    }
  }

  /** POST /v1/ai-bot/connect（challenge + privateKey 签名换取运行 token） */
  static async connectBot(apiUrl: string, botUid: string, privateKeyPem: string): Promise<PufferfishAccount> {
    const base = PufferfishAPIClient.normalizeBaseUrl(apiUrl);
    const challengeResp = await fetch(`${base}/v1/ai-bot/connect/challenge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ botUid }),
    });
    if (!challengeResp.ok) {
      const text = await challengeResp.text().catch(() => '');
      throw new Error(`connect challenge 失败: ${challengeResp.status} ${text}`);
    }
    const challenge = await challengeResp.json() as {
      challengeId?: string;
      nonce?: string;
    };
    const challengeId = String(challenge.challengeId ?? '').trim();
    const nonceB64 = String(challenge.nonce ?? '').trim();
    if (!challengeId || !nonceB64) {
      throw new Error(`connect challenge 返回异常: ${JSON.stringify(challenge)}`);
    }

    const nonceBytes = Buffer.from(nonceB64, 'base64');
    if (!nonceBytes.length) {
      throw new Error('connect challenge nonce 解析失败');
    }
    const key = crypto.createPrivateKey(privateKeyPem);
    const signature = crypto.sign(null, nonceBytes, key).toString('base64');

    const response = await fetch(`${base}/v1/ai-bot/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ botUid, challengeId, signature }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`connect 失败: ${response.status} ${text}`);
    }

    const data = await response.json() as {
      accountId?: string;
      botUid?: string;
      enabled?: boolean;
      apiUrl?: string;
      wsUrl?: string;
      botUserId?: number;
      token?: string;
    };
    if (!data.enabled || !data.apiUrl || !data.wsUrl || !data.botUserId || !data.token) {
      throw new Error(`connect 返回异常: ${JSON.stringify(data)}`);
    }
    const normalizedWsUrl = PufferfishAPIClient.normalizeWsUrl(data.apiUrl, data.wsUrl);
    console.log(
      `[Pufferfish API] connect success` +
        ` accountId=${data.accountId ?? botUid}` +
        ` botUid=${data.botUid ?? botUid}` +
        ` botUserId=${data.botUserId}` +
        ` apiUrl=${data.apiUrl}` +
        ` wsUrlRaw=${data.wsUrl}` +
        ` wsUrlNormalized=${normalizedWsUrl}` +
        ` tokenPrefix=${String(data.token).slice(0, 8)}`,
    );
    return {
      accountId: data.accountId ?? botUid,
      enabled: true,
      apiUrl: data.apiUrl,
      wsUrl: normalizedWsUrl,
      botUserId: Number(data.botUserId),
      botUid: data.botUid ?? botUid,
      token: data.token,
    };
  }

  /**
   * 发送消息到 Pufferfish
   */
  async sendMessage(params: SendMessageRequest): Promise<SendMessageResponse> {
    const encodedContent = this.encodeMessageContent(params.type, params.content, params.metadata);
    console.log(
      `[Pufferfish API] BotSendMessage content encoded type=${params.type} ` +
        `rawLen=${(params.content ?? '').length} ` +
        `encodedLen=${encodedContent.length} ` +
        `encodedPrefix=${encodedContent.slice(0, 12)}`,
    );
    const body = JSON.stringify({
      botId: this.accountBotId(),
      chatId: params.chatId,
      messageType: params.type,
      content: encodedContent,
      metadata: this.toStringMap(params.metadata),
    });
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };

    const response = await fetch(`${this.baseURL}/v1.AIBot/BotSendMessage`, {
      method: 'POST',
      headers,
      body,
    });

    if (!response.ok) {
      throw new Error(`Failed to send message: ${response.status} ${response.statusText}`);
    }

    return response.json();
  }

  /**
   * 发送流式消息到 Pufferfish（支持打字效果）
   * @param params 流式消息参数
   */
  async sendStreamMessage(params: {
    chatId: string;
    content: string;
    isStream: boolean;
    streamEnd: boolean;
  }): Promise<SendMessageResponse> {
    const encodedContent = this.encodeMessageContent('text', params.content, {
      isStream: params.isStream,
      streamEnd: params.streamEnd,
    });
    const body = JSON.stringify({
      botId: this.accountBotId(),
      chatId: params.chatId,
      messageType: 'text',
      content: encodedContent,
      metadata: {
        isStream: params.isStream,
        streamEnd: params.streamEnd,
      },
    });

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };

    const response = await fetch(`${this.baseURL}/v1.AIBot/BotSendMessage`, {
      method: 'POST',
      headers,
      body,
    });

    if (!response.ok) {
      throw new Error(`Failed to send stream message: ${response.status} ${response.statusText}`);
    }

    return response.json();
  }

  /**
   * 上传文件到 Pufferfish OSS
   */
  async uploadFile(fileData: Buffer, fileName: string): Promise<string> {
    // 1. 获取预签名 URL
    const presignedResp = await fetch(`${this.baseURL}/v1/file/presigned`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ fileName }),
    });

    if (!presignedResp.ok) {
      throw new Error('Failed to get presigned URL');
    }

    const { uploadUrl, publicUrl } = await presignedResp.json();

    // 2. 上传文件
    const uploadResp = await fetch(uploadUrl, {
      method: 'PUT',
      body: new Uint8Array(fileData),
    });

    if (!uploadResp.ok) {
      throw new Error('Failed to upload file');
    }

    return publicUrl;
  }

  /**
   * 下载文件
   */
  async downloadFile(url: string): Promise<Buffer> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download file: ${response.status}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  private accountBotId(): number {
    return this.botUserId;
  }

  /**
   * 将 OpenClaw 的出站消息封装为 Pufferfish 客户端可解析的 MessageContent(base64(json))。
   *
   * Pufferfish 客户端在 encryptVersion=0 时仍会对 content 做 base64Decode + jsonDecode，
   * 所以这里必须发送 base64(JSON.stringify(MessageContent)).
   */
  private encodeMessageContent(
    type: 'text' | 'image' | 'file',
    content: string,
    metadata?: Record<string, any>,
  ): string {
    const kind = type;
    const msg: any = { kind };
    if (type === 'text') {
      msg.text = content;
    } else if (type === 'image') {
      msg.mediaList = [{ url: content }];
      if (metadata?.caption) {
        msg.mediaList[0].caption = String(metadata.caption);
      }
    } else if (type === 'file') {
      msg.file = {
        url: content,
        name: String(metadata?.fileName ?? 'file'),
      };
      if (metadata?.caption) {
        msg.file.caption = String(metadata.caption);
      }
    } else {
      msg.text = content;
    }
    const json = JSON.stringify(msg);
    return Buffer.from(json, 'utf8').toString('base64');
  }

  private toStringMap(input?: Record<string, any>): Record<string, string> {
    const out: Record<string, string> = {};
    if (!input) return out;
    for (const [k, v] of Object.entries(input)) {
      out[k] = typeof v === 'string' ? v : JSON.stringify(v);
    }
    return out;
  }
}
