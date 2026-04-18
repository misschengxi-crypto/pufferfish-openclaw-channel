import WebSocket from 'ws';
import { EventEmitter } from 'events';
import type { PufferfishAccount, PufferfishMessage } from './types.js';
import { getPluginVersion } from './plugin-version.js';

/**
 * Pufferfish WebSocket 客户端
 * 负责与 Pufferfish 服务器建立 WebSocket 长连接，接收实时消息
 * 
 * 事件:
 * - 'connected': WebSocket 连接成功
 * - 'disconnected': WebSocket 断开连接
 * - 'message': 收到新消息 (PufferfishMessage)
 * - 'error': 发生错误
 */
export class PufferfishWebSocketClient extends EventEmitter {
  private ws: WebSocket | null = null;              // WebSocket 连接实例
  private account: PufferfishAccount;               // 账号配置
  private reconnectTimer: NodeJS.Timeout | null = null;  // 重连定时器
  private heartbeatTimer: NodeJS.Timeout | null = null;  // 心跳定时器
  private isConnecting = false;                     // 是否正在连接中
  private shouldReconnect = true;                   // 是否应该自动重连
  private ackedMessageIds = new Set<string>();      // 已回执的 messageId（避免重复 ack）
  private ackedQueue: string[] = [];                // 有序队列，用于限制 Set 大小
  private static readonly pluginVersion = getPluginVersion();

  constructor(account: PufferfishAccount) {
    super();
    this.account = account;
  }

  private prefix(): string {
    const botUserId = this.account?.botUserId ?? 0;
    const accountId = this.account?.accountId ?? 'unknown';
    return `[Pufferfish WS] [accountId=${accountId}] [botUserId=${botUserId}]`;
  }

  private tokenDigest(token: string): string {
    const value = String(token ?? '').trim();
    if (!value) return '';
    // 仅用于排查 token 是否变化，避免输出明文 token
    return Buffer.from(value).toString('base64').slice(0, 12);
  }

  /** 服务端重新签发运行 token 时同步，避免重连仍用旧 token */
  updateAccount(account: PufferfishAccount): void {
    this.account = account;
  }

  isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * 连接到 Pufferfish WebSocket 服务器
   */
  async connect(): Promise<void> {
    if (this.isConnecting || (this.ws && this.ws.readyState === WebSocket.OPEN)) {
      return;
    }

    this.isConnecting = true;
    const tokenQ = encodeURIComponent(this.account.token);
    const botIdQ = encodeURIComponent(String(this.account.botUserId));
    const wsUrl = `${this.account.wsUrl}?token=${tokenQ}&botId=${botIdQ}`;
    const wsProtocol = (() => {
      try {
        return new URL(this.account.wsUrl).protocol;
      } catch {
        return 'invalid';
      }
    })();

    try {
      console.log(
        `${this.prefix()} Connecting...` +
          ` wsUrlBase=${this.account.wsUrl}` +
          ` wsProtocol=${wsProtocol}` +
          ` hasToken=${Boolean(this.account.token)}` +
          ` tokenDigest=${this.tokenDigest(this.account.token)}` +
          ` botId=${this.account.botUserId}` +
          ` queryKeys=token,botId`,
      );
      this.ws = new WebSocket(wsUrl);

      this.ws.on('open', () => {
        this.isConnecting = false;
        this.emit('connected');
        // 连接建立后立即发送 hello，声明插件版本与能力集合。
        this.send({
          action: 'hello',
          pluginVersion: PufferfishWebSocketClient.pluginVersion,
        });
        this.startHeartbeat();
        console.log(`${this.prefix()} Connected`);
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        try {
          const raw = data.toString();
          const parsed = JSON.parse(raw) as any;
          if (parsed && typeof parsed === 'object' && typeof parsed.action === 'string') {
            const action = String(parsed.action).toLowerCase();
            if (action === 'hello_ack') {
              // hello_ack 是控制帧，不应进入普通消息处理流。
              const status = String(parsed.status ?? 'pending').toLowerCase();
              const normalizedStatus =
                status === 'ok' || status === 'degraded' || status === 'reject' ? status : 'pending';
              this.emit('hello_ack', parsed);
              console.log(
                `${this.prefix()} Handshake ack` +
                  ` status=${normalizedStatus}` +
                  ` minPluginVersion=${parsed.minPluginVersion ?? 'unknown'}`,
              );
              return;
            }
            if (action === 'error') {
              // 服务端门禁失败（如 FEATURE_NOT_SUPPORTED）统一走控制帧事件。
              this.emit('channel_error', parsed);
              console.warn(`${this.prefix()} Server channel error`, parsed);
              return;
            }
          }
          const message = parsed as PufferfishMessage;
          console.log(
            `${this.prefix()} Inbound message received` +
              ` messageId=${(message as any)?.messageId ?? 'unknown'}` +
              ` chatId=${(message as any)?.chatId ?? 'unknown'}` +
              ` userId=${(message as any)?.userId ?? 'unknown'}` +
              ` type=${(message as any)?.type ?? 'unknown'}` +
              ` isStream=${(message as any)?.isStream ?? false}` +
              ` streamEnd=${(message as any)?.streamEnd ?? false}` +
              ` rawLen=${raw.length}`,
          );
          this.ackInboundMessage((message as any)?.messageId);
          this.emit('message', message);
        } catch (error) {
          const raw = data?.toString?.() ?? '';
          console.error(`${this.prefix()} Failed to parse message:`, error, `rawLen=${raw.length}`, raw);
        }
      });

      this.ws.on('close', () => {
        this.isConnecting = false;
        this.stopHeartbeat();
        this.emit('disconnected');
        console.log(`${this.prefix()} Disconnected`);

        if (this.shouldReconnect) {
          this.scheduleReconnect();
        }
      });

      this.ws.on('error', (error) => {
        this.isConnecting = false;
        console.error(
          `${this.prefix()} Error:` +
            ` wsUrlBase=${this.account.wsUrl}` +
            ` wsProtocol=${wsProtocol}` +
            ` tokenDigest=${this.tokenDigest(this.account.token)}` +
            ` botId=${this.account.botUserId}`,
          error,
        );
        this.emit('error', error);
      });

      this.ws.on('pong', () => {
        // 收到 pong 响应，连接正常
      });
    } catch (error) {
      this.isConnecting = false;
      throw error;
    }
  }

  /**
   * 断开连接
   */
  disconnect(): void {
    this.shouldReconnect = false;
    this.stopHeartbeat();
    
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * 发送消息（用于心跳等）
   */
  send(data: any): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  /**
   * 回执服务端下行消息，避免断线补投导致重复触发 Agent。
   *
   * 约定：服务端支持 action=ack，字段 ackIds 或 messageId。
   */
  private ackInboundMessage(messageId: unknown): void {
    const id = typeof messageId === 'string' ? messageId.trim() : '';
    if (!id) return;
    if (this.ackedMessageIds.has(id)) return;

    this.ackedMessageIds.add(id);
    this.ackedQueue.push(id);

    const maxSize = 5000;
    if (this.ackedQueue.length > maxSize) {
      const removed = this.ackedQueue.splice(0, this.ackedQueue.length - maxSize);
      for (const r of removed) {
        this.ackedMessageIds.delete(r);
      }
    }

    try {
      this.send({ action: 'ack', ackIds: [id] });
    } catch (_) {
      // ack 失败不影响主流程，重连后服务端会重发，届时会再次 ack
    }
  }

  /**
   * 启动心跳
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, 30000); // 30秒心跳
  }

  /**
   * 停止心跳
   */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * 计划重连
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return;
    }

    console.log('[Pufferfish WS] Reconnecting in 3 seconds...');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((error) => {
        console.error('[Pufferfish WS] Reconnect failed:', error);
      });
    }, 3000);
  }
}
