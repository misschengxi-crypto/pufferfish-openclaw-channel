import { PufferfishAPIClient } from './api-client.js';
import type { PufferfishAccount } from './types.js';

const runtimeAccounts = new Map<string, PufferfishAccount>();

export function setRuntimeAccount(account: PufferfishAccount): void {
  runtimeAccounts.set(account.accountId, account);
}

export function removeRuntimeAccount(accountId: string): void {
  runtimeAccounts.delete(accountId);
}

/**
 * 与 Pufferfish 服务端 parseChatId 一致：私聊 user_{id}、群聊 group_{id}
 */
function normalizePufferfishChatId(raw: string): string {
  const t = raw.trim();
  if (!t) return t;

  const userColon = /^user:(\d+)$/i.exec(t);
  if (userColon) return `user_${userColon[1]}`;
  if (/^user_\d+$/i.test(t)) return t;

  const groupColon = /^group:(\d+)$/i.exec(t);
  if (groupColon) return `group_${groupColon[1]}`;
  if (/^group_\d+$/i.test(t)) return t;

  const channelNum = t.match(/^channel:(\d+)$/i);
  if (channelNum) return `group_${channelNum[1]}`;

  if (/^\d+$/.test(t)) return `user_${t}`;

  return t;
}

function resolvePufferfishAccountFromConfig(cfg: any, accountId?: string): PufferfishAccount {
  const runtime = runtimeAccounts.get(accountId ?? 'default');
  if (runtime) {
    return runtime;
  }

  const account = cfg.channels?.pufferfish?.bots?.[accountId ?? 'default'] ?? cfg.channels?.pufferfish?.accounts?.[accountId ?? 'default'];
  return {
    accountId: accountId ?? 'default',
    enabled: account?.enabled ?? true,
    apiUrl: account?.apiUrl ?? 'http://localhost:8080',
    wsUrl: account?.wsUrl ?? 'ws://localhost:8080/v1/ai-bot/ws',
    botUserId: account?.botUserId ?? 0,
    botUid: typeof account?.botUid === 'string' ? account.botUid : accountId ?? 'default',
    token: account?.token ?? '',
  };
}

function resolveOutboundCtx(ctx: any): { chatId: string; account: PufferfishAccount } {
  const rawTarget = String(ctx.chatId ?? ctx.to ?? '').trim();
  const chatId = normalizePufferfishChatId(rawTarget);
  const account = ctx.account ?? resolvePufferfishAccountFromConfig(ctx.cfg, ctx.accountId);
  return { chatId, account };
}

/**
 * Pufferfish Channel 定义
 * 实现 OpenClaw Channel 接口，连接到 Pufferfish IM 平台
 */
export const pufferfishChannel = {
  id: 'pufferfish',

  // 元数据：Channel 的基本信息
  meta: {
    id: 'pufferfish',
    label: 'QQvu',
    selectionLabel: 'Pufferfish (即时通讯平台)',
    docsPath: '/channels/pufferfish',
    blurb: 'Connect to Pufferfish instant messaging platform with AI capabilities',
    aliases: ['pf', 'pufferfish-im'],
  },

  // 能力声明：支持的功能
  capabilities: {
    chatTypes: ['direct', 'group'] as const,  // 支持私聊和群聊
    media: ['text', 'image', 'file'] as const, // 支持文本、图片、文件
    mentions: true,   // 支持 @提及
    threads: false,   // 不支持消息线程
  },

  // 配置解析：从 OpenClaw 配置文件读取账号信息
  config: {
    // 列出所有配置的账号ID
    listAccountIds: (cfg: any) =>
      Object.keys(cfg.channels?.pufferfish?.bots ?? cfg.channels?.pufferfish?.accounts ?? {}),

    // 解析指定账号的配置
    resolveAccount: (cfg: any, accountId?: string): PufferfishAccount =>
      resolvePufferfishAccountFromConfig(cfg, accountId),
  },

  /**
   * OpenClaw 工具「发消息」解析 to：纯数字或 user: 等形式需映射为服务端 chatId；
   * 否则会走「通讯录」目录匹配，本通道未实现 directory 时会报 Unknown target。
   */
  messaging: {
    normalizeTarget: (raw: string) => normalizePufferfishChatId(raw),
    inferTargetChatType: ({ to }: { to: string }) => {
      const t = String(to ?? '').trim();
      if (/^group_\d+$/i.test(t)) return 'group';
      if (/^group:\d+$/i.test(t)) return 'group';
      if (/^channel:\d+$/i.test(t)) return 'group';
      if (/^user_\d+$/i.test(t)) return 'direct';
      if (/^user:\d+$/i.test(t)) return 'direct';
      if (/^\d+$/.test(t)) return 'direct';
      return undefined;
    },
    targetResolver: {
      hint:
        '私聊：`user_<用户数字ID>`、`user:<ID>` 或直接写用户数字 ID；群：`group_<群ID>` 或 `group:<ID>`。',
      looksLikeId: (trimmed: string) => {
        if (/^(user|group)_\d+$/i.test(trimmed)) return true;
        if (/^(user|group):\d+$/i.test(trimmed)) return true;
        if (/^channel:\d+$/i.test(trimmed)) return true;
        if (/^\d+$/.test(trimmed)) return true;
        return false;
      },
      resolveTarget: async (params: {
        input: string;
        normalized: string;
        preferredKind?: string;
      }) => {
        const raw = (params.normalized?.trim() ? params.normalized : params.input).trim();
        let chatId = normalizePufferfishChatId(raw);
        if (params.preferredKind === 'group' && /^\d+$/.test(raw)) {
          chatId = `group_${raw}`;
        } else if (params.preferredKind === 'user' && /^\d+$/.test(raw)) {
          chatId = `user_${raw}`;
        }
        const kind = /^group_/i.test(chatId) ? 'group' : 'user';
        const display = chatId.replace(/^(user|group)_/i, '');
        return {
          to: chatId,
          kind,
          display,
          source: 'normalized' as const,
        };
      },
    },
  },

  // 出站消息处理：AI 发送消息给用户
  outbound: {
    deliveryMode: 'direct' as const,  // 直接发送模式

    /**
     * OpenClaw 传入 ctx：`to`（投递目标）、`accountId`、`cfg`；与自定义 chatId / account 兼容。
     */
    sendText: async (ctx: any) => {
      const { text, streaming } = ctx;
      const { chatId, account } = resolveOutboundCtx(ctx);

      const client = new PufferfishAPIClient(account);

      try {
        if (streaming) {
          const chunkSize = 10;
          const chunks = [];
          for (let i = 0; i < text.length; i += chunkSize) {
            chunks.push(text.substring(0, i + chunkSize));
          }

          for (let i = 0; i < chunks.length; i++) {
            const isLast = i === chunks.length - 1;
            await client.sendStreamMessage({
              chatId,
              content: chunks[i],
              isStream: true,
              streamEnd: isLast,
            });
            if (!isLast) {
              await new Promise(resolve => setTimeout(resolve, 50));
            }
          }
        } else {
          await client.sendMessage({
            chatId,
            type: 'text',
            content: text,
          });
        }
        return { ok: true };
      } catch (error: any) {
        console.error('[Pufferfish Channel] Failed to send text:', error);
        return { ok: false, error: error.message };
      }
    },

    sendImage: async (ctx: any) => {
      const imageUrl = ctx.imageUrl ?? ctx.mediaUrl;
      const { chatId, account } = resolveOutboundCtx(ctx);

      const client = new PufferfishAPIClient(account);

      try {
        const imageData = await client.downloadFile(imageUrl);

        const ossUrl = await client.uploadFile(imageData, 'image.jpg');

        await client.sendMessage({
          chatId,
          type: 'image',
          content: ossUrl,
        });

        return { ok: true };
      } catch (error: any) {
        console.error('[Pufferfish Channel] Failed to send image:', error);
        return { ok: false, error: error.message };
      }
    },

    sendFile: async (ctx: any) => {
      const { fileUrl, fileName, mediaUrl } = ctx;
      const url = fileUrl ?? mediaUrl;
      const { chatId, account } = resolveOutboundCtx(ctx);

      const client = new PufferfishAPIClient(account);

      try {
        const fileData = await client.downloadFile(url);
        const name = fileName ?? 'file.bin';

        const ossUrl = await client.uploadFile(fileData, name);

        await client.sendMessage({
          chatId,
          type: 'file',
          content: ossUrl,
          metadata: { fileName: name },
        });

        return { ok: true };
      } catch (error: any) {
        console.error('[Pufferfish Channel] Failed to send file:', error);
        return { ok: false, error: error.message };
      }
    },
  },
};
