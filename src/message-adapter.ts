import type { PufferfishMessage, OpenClawMessage } from './types.js';

/**
 * 消息格式适配器
 * 负责在 Pufferfish 消息格式和 OpenClaw 消息格式之间转换
 */
export class MessageAdapter {
  /**
   * 尝试从 Pufferfish 侧透传的 content 中解码 MessageContent(base64(JSON))。
   *
   * Pufferfish 服务端在 WS 转发时会原样透传 `message.Content`，
   * 而该字段在 encryptVersion=0 时是 base64(JSON)。
   *
   * 解码失败则返回 null，调用方应回退使用原始 msg.content。
   */
  private tryDecodeMessageContent(content: string): any | null {
    if (!content) return null;
    try {
      const jsonStr = Buffer.from(content, 'base64').toString('utf8');
      return JSON.parse(jsonStr);
    } catch (_) {
      return null;
    }
  }

  /**
   * 将 Pufferfish 消息转换为 OpenClaw 格式
   * @param msg Pufferfish 消息对象
   * @returns OpenClaw 消息对象
   */
  toOpenClawMessage(msg: PufferfishMessage): OpenClawMessage {
    const result: OpenClawMessage = {
      metadata: {
        messageId: msg.messageId,
        chatId: msg.chatId,
        userId: msg.userId,
        timestamp: msg.timestamp,
        ...msg.metadata,
      },
    };

    // 入站 WS 的 msg.content 在 Pufferfish 里通常是 MessageContent(base64(JSON))，
    // 这里先尝试解码，拿到真实 text/url 再映射到 OpenClaw。
    const decoded = this.tryDecodeMessageContent(msg.content);

    switch (msg.type) {
      case 'text':
        // MessageContent: { kind: 'text', text: '...' }
        if (decoded?.kind === 'text' && typeof decoded?.text === 'string') {
          result.text = decoded.text;
        } else {
          result.text = msg.content;
        }
        break;
      
      case 'image':
        // MessageContent: { kind: 'image', mediaList: [{ url: '...' }] }
        const imgUrl: string | undefined =
          decoded?.kind === 'image'
            ? decoded?.mediaList?.[0]?.url
            : undefined;
        result.imageUrl = imgUrl || msg.content;
        result.text = '[图片]';
        break;
      
      case 'file':
        // MessageContent: { kind: 'file', file: { url: '...', name: '...' } }
        const fileUrl: string | undefined =
          decoded?.kind === 'file' ? decoded?.file?.url : undefined;
        const fileNameFromContent: string | undefined =
          decoded?.kind === 'file' ? decoded?.file?.name : undefined;

        result.fileUrl = fileUrl || msg.content;
        result.fileName =
          fileNameFromContent || msg.metadata?.fileName || 'file';
        result.text = `[文件: ${result.fileName}]`;
        break;
      
      case 'audio':
        // MessageContent: { kind: 'audio', mediaList: [{ url: '...' }] }
        const audioUrl: string | undefined =
          decoded?.kind === 'audio' ? decoded?.mediaList?.[0]?.url : undefined;
        result.fileUrl = audioUrl || msg.content;
        result.text = '[语音消息]';
        break;
      
      case 'video':
        // MessageContent: { kind: 'video', mediaList: [{ url: '...' }] }
        const videoUrl: string | undefined =
          decoded?.kind === 'video'
            ? decoded?.mediaList?.[0]?.url
            : undefined;
        result.fileUrl = videoUrl || msg.content;
        result.text = '[视频]';
        break;
      
      default:
        // 兜底：尽量还是给文本，便于 Agent 继续工作
        result.text =
          (decoded?.kind === 'text' && typeof decoded?.text === 'string'
            ? decoded.text
            : msg.content) as string;
    }

    return result;
  }

  /**
   * 从 OpenClaw 消息提取文本内容
   */
  extractText(msg: OpenClawMessage): string {
    return msg.text || '';
  }

  /**
   * 检查消息是否包含图片
   */
  hasImage(msg: OpenClawMessage): boolean {
    return !!msg.imageUrl;
  }

  /**
   * 检查消息是否包含文件
   */
  hasFile(msg: OpenClawMessage): boolean {
    return !!msg.fileUrl;
  }
}
