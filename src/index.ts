/**
 * OpenClaw「Pufferfish」通道插件入口。
 *
 * 职责概览：
 * - 向 OpenClaw 注册 `pufferfish` 通道（见 channel.ts）
 * - 从 `api.config.channels.pufferfish` 读取多机器人配置，用私钥换运行 token 并维持 WebSocket
 * - 将 Pufferfish 下行消息适配为 OpenClaw 入站上下文，经 runtime 调度 Agent，再把回复发回 IM
 *
 * 注意：OpenClaw 安全扫描会拦截「读取外部进程环境 + 网络发送」的组合模式；
 * 本插件不读取环境变量，也不再用本地绝对路径兜底加载 openclaw 模块。
 */
import { pufferfishChannel, removeRuntimeAccount, setRuntimeAccount } from './channel.js';
import { PufferfishWebSocketClient } from './websocket-client.js';
import { MessageAdapter } from './message-adapter.js';
import { PufferfishAPIClient } from './api-client.js';
import type {
  PufferfishAccount,
  PufferfishBotProfile,
  PufferfishBotConfig,
} from './types.js';
import {channel} from "node:diagnostics_channel";

/**
 * OpenClaw 插件注册函数
 * 这是插件的入口点，OpenClaw 启动时会调用此函数
 * @param api OpenClaw Plugin API 对象
 */
export default function register(api: any) {
  api.logger.info('======Pufferfish Channel Plugin loaded!=======');

  // 注册 Pufferfish Channel 到 OpenClaw
  api.registerChannel({ plugin: pufferfishChannel });

  // OpenClaw 2026+：完整配置在 api.config（旧版 api.getConfig 已移除）
  const config = api.config ?? {};
  const channelConfig = config.channels?.pufferfish ?? {};
  // 多机器人：key 为配置里的 accountId（推荐直接使用 botUid 作为 key）
  const botConfigs = (channelConfig.bots ?? {}) as Record<string, PufferfishBotConfig>;

  /** 每个已启用账号一条 WebSocket 连接，与 channel 层共享 account 快照（setRuntimeAccount） */
  const runtimeConnections = new Map<string, {
    account: PufferfishAccount;
    wsClient: PufferfishWebSocketClient;
  }>();

  // Bot 侧 systemPrompt / skills 按 botUid 查找
  const botProfilesByBotUid = (channelConfig.botProfilesByBotUid ?? {}) as Record<string, PufferfishBotProfile>;

  /** 去重、去空白的 skills 列表，供 sync_config 发给服务端 */
  const normalizeSkills = (skills: unknown): string[] => {
    if (!Array.isArray(skills)) return [];
    const unique = new Set<string>();
    const result: string[] = [];
    for (const item of skills) {
      const value = typeof item === 'string' ? item.trim() : '';
      if (!value || unique.has(value)) continue;
      unique.add(value);
      result.push(value);
    }
    return result;
  };

  /** 按 botUid 读取 profile（systemPrompt / skills） */
  const resolveBotProfile = (account: PufferfishAccount): PufferfishBotProfile => {
    const byUid =
      account.botUid && botProfilesByBotUid[account.botUid] ? botProfilesByBotUid[account.botUid] : {};
    return {
      systemPrompt: byUid.systemPrompt,
      skills: byUid.skills,
    };
  };

  /** WS 就绪后把 systemPrompt + skills 同步给 Pufferfish 服务端（无 prompt 则跳过并打日志） */
  const sendSyncConfig = (account: PufferfishAccount, wsClient: PufferfishWebSocketClient): void => {
    if (!wsClient.isOpen()) {
      return;
    }

    const profile = resolveBotProfile(account);
    const systemPrompt = String(profile.systemPrompt ?? '').trim();
    const skills = normalizeSkills(profile.skills);

    if (!systemPrompt) {
      api.logger.warn(
        `sync_config 缺少 systemPrompt，已跳过 [accountId=${account.accountId}] [botUserId=${account.botUserId}]`,
      );
      return;
    }

    wsClient.send({
      action: 'sync_config',
      systemPrompt,
      skills,
    });

    api.logger.info(
      `已发送 sync_config [accountId=${account.accountId}] [botUserId=${account.botUserId}] [skills=${skills.length}]`,
    );
  };

  /**
   * 将一条 Pufferfish 会话消息喂给 OpenClaw：拼 envelope → 写入 session → 调度 Agent → deliver 回 IM。
   * 依赖 api.runtime.channel 上的一组内部 API；缺任一能力则抛错，避免半套集成。
   */
  const ingestIncomingMessage = async (payload: {
    account: PufferfishAccount;
    channelId: string;
    accountId: string;
    chatId: string;
    senderId: string;
    messageId: string;
    message: any;
    timestamp: number;
  }): Promise<void> => {
    const rawBody = typeof payload?.message?.text === 'string' ? payload.message.text : '';
    const tsMs = payload.timestamp < 1e12 ? payload.timestamp * 1000 : payload.timestamp;

    const senderAddress = `${payload.channelId}:${payload.senderId}`;
    const recipientAddress = payload.chatId;
    const conversationLabel = payload.chatId;

    /**
     * 模型有时返回工具 JSON 或带 ```json 的块；尽量抽出 parameters.message 作为最终对用户可见文本。
     */
    const normalizeReplyText = (raw: string): string => {
      const s = String(raw ?? '');
      if (!s.trim()) return '';

      const fenced = s.match(/```json\s*([\s\S]*?)\s*```/i);
      const candidate = fenced?.[1]?.trim() ?? (s.trim().startsWith('{') ? s.trim() : '');
      if (candidate) {
        try {
          const obj: any = JSON.parse(candidate);
          const msg = obj?.parameters?.message;
          if (typeof msg === 'string' && msg.trim()) {
            return msg.trim();
          }
        } catch (_) {
          // ignore parse failures
        }
      }

      const inlineMsg = s.match(/"message"\s*:\s*"((?:\\.|[^"\\])*)"/);
      if (inlineMsg?.[1]) {
        return inlineMsg[1]
          .replace(/\\"/g, '"')
          .replace(/\\n/g, '\n')
          .trim();
      }

      return s;
    };

    const channelRuntime = api?.runtime?.channel;
    if (
      !channelRuntime?.routing?.resolveAgentRoute ||
      !channelRuntime?.session?.resolveStorePath ||
      !channelRuntime?.session?.readSessionUpdatedAt ||
      !channelRuntime?.session?.recordInboundSession ||
      !channelRuntime?.reply?.resolveEnvelopeFormatOptions ||
      !channelRuntime?.reply?.formatAgentEnvelope ||
      !channelRuntime?.reply?.finalizeInboundContext ||
      !channelRuntime?.reply?.dispatchReplyWithBufferedBlockDispatcher
    ) {
      throw new Error('OpenClaw runtime.channel 能力不完整，无法处理入站消息。');
    }

    /** OpenClaw 在 Agent 产出回复后调用：可选执行内联工具计划、上传媒体、再发文本消息 */
    const deliver = async (outboundPayload: any): Promise<void> => {
      const client = new PufferfishAPIClient(payload.account);
      // 将“被取消的触发轮次”透传给服务端，服务端收到 BotSendMessage 时可直接丢弃。
      const cancelMeta = { cancel_target_msg_id: payload.messageId };
      const rawText = typeof outboundPayload?.text === 'string' ? outboundPayload.text : '';

      // 打印模型回复，便于排查（避免日志过长，仅截断）
      try {
        const prefix = '[Pufferfish Channel] Model reply';
        api.logger.info(
          `${prefix} chatId=${payload.chatId} botUserId=${payload.account?.botUserId ?? 'unknown'} rawLen=${rawText.length} rawPreview=${rawText.slice(0, 800)}`,
        );
        if (rawText.includes('```json') || rawText.includes('pufferfish_get_user_info')) {
          api.logger.info(
            `${prefix} contains tool-plan markers (hasFenceJson=${rawText.includes('```json')})`,
          );
        }
      } catch (_) {
        // ignore logger errors
      }

      // 兜底：如果模型输出的是“工具调用计划”（例如 fenced JSON：{ name, parameters }）
      // 但没有真正执行工具，那么这里尝试按最常见工具做一次本地执行，
      // 直接把工具结果转成自然语言再发回 Pufferfish。
      const tryExecuteToolCallPlan = async (raw: string): Promise<string | null> => {
        if (!raw || !raw.includes('```json')) return null;
        const blocks = raw.match(/```json\s*([\s\S]*?)\s*```/gi) ?? [];
        if (blocks.length === 0) return null;

        const baseUrl = String(payload.account.apiUrl ?? '')
          .trim()
          .replace(/\/+$/, '')
          .replace(/\/v1$/, '');
        const token = String(payload.account.token ?? '');
        if (!baseUrl || !token) return null;

        for (const block of blocks) {
          // 只解析 code fence 内 JSON
          const candidate = block.replace(/```json/i, '').replace(/```/g, '').trim();
          if (!candidate) continue;
          let obj: any;
          try {
            obj = JSON.parse(candidate);
          } catch (_) {
            continue;
          }

          const toolName = obj?.name;
          const params = obj?.parameters ?? {};
          if (toolName === 'pufferfish_get_user_info') {
            const userId = params?.userId;
            if (typeof userId !== 'number') continue;

            try {
              const resp = await fetch(`${baseUrl}/v1/user/${userId}`, {
                method: 'GET',
                headers: {
                  Authorization: `Bearer ${token}`,
                  'Content-Type': 'application/json',
                },
              });
              if (!resp.ok) {
                continue;
              }
              const user = await resp.json();
              const nickname = user?.nickname ?? '';
              const username = user?.username ?? '';
              if (nickname && username) {
                return `用户信息: ${nickname} (@${username})`;
              }
              return nickname ? `用户信息: ${nickname}` : null;
            } catch (_) {
              continue;
            }
          }
        }

        return null;
      };

      const executedText = await tryExecuteToolCallPlan(rawText);
      if (executedText != null && executedText !== rawText) {
        try {
          api.logger.info(
            `[Pufferfish Channel] executed tool-plan -> preview=${executedText.slice(0, 800)}`,
          );
        } catch (_) {
          // ignore logger errors
        }
      }
      const text = normalizeReplyText(executedText ?? rawText);

      const mediaUrls: string[] = Array.isArray(outboundPayload?.mediaUrls)
        ? outboundPayload.mediaUrls
        : outboundPayload?.mediaUrl
          ? [outboundPayload.mediaUrl]
          : [];

      // 先发媒体，再发文本（Pufferfish 侧不支持“媒体内嵌 caption”，所以只能拆成两条）
      for (const mediaUrl of mediaUrls) {
        const buf = await client.downloadFile(mediaUrl);
        const mime = api?.runtime?.media?.detectMime
          ? await api.runtime.media.detectMime({ buffer: buf })
          : undefined;

        if (mime && mime.startsWith('image/')) {
          const ossUrl = await client.uploadFile(buf, 'image.jpg');
          await client.sendMessage({
            chatId: payload.chatId,
            type: 'image',
            content: ossUrl,
            metadata: cancelMeta,
          });
        } else {
          const fileExt = mime?.split('/')?.[1] ?? 'bin';
          const fileName = `file.${fileExt}`;
          const ossUrl = await client.uploadFile(buf, fileName);
          await client.sendMessage({
            chatId: payload.chatId,
            type: 'file',
            content: ossUrl,
            metadata: { fileName, ...cancelMeta },
          });
        }
      }

      if (text) {
        await client.sendMessage({
          chatId: payload.chatId,
          type: 'text',
          content: text,
          metadata: cancelMeta,
        });
      }
    };

    // 解析该 peer 对应的 Agent 与会话存储路径
    const route = channelRuntime.routing.resolveAgentRoute({
      cfg: api.config,
      channel: payload.channelId,
      accountId: payload.accountId,
      peer: {
        kind: 'direct',
        id: payload.senderId,
      },
    });
    const storePath = channelRuntime.session.resolveStorePath(api.config?.session?.store, {
      agentId: route.agentId,
    });
    // 用于 envelope 里的「相对上次更新时间」等元信息
    const previousTimestamp = channelRuntime.session.readSessionUpdatedAt({
      storePath,
      sessionKey: route.sessionKey,
    });
    const envelopeOptions = channelRuntime.reply.resolveEnvelopeFormatOptions(api.config);
    const body = channelRuntime.reply.formatAgentEnvelope({
      channel: pufferfishChannel?.meta?.label ?? payload.channelId,
      from: conversationLabel,
      timestamp: tsMs,
      previousTimestamp,
      envelope: envelopeOptions,
      body: rawBody,
    });
    // 供 session 与 reply 管线使用的统一入站上下文
    const ctxPayload = channelRuntime.reply.finalizeInboundContext({
      Body: body,
      BodyForAgent: rawBody,
      RawBody: rawBody,
      CommandBody: rawBody,
      From: senderAddress,
      To: recipientAddress,
      SessionKey: route.sessionKey,
      AccountId: route.accountId ?? payload.accountId,
      ChatType: 'direct',
      ConversationLabel: conversationLabel,
      SenderId: payload.senderId,
      Provider: payload.channelId,
      Surface: payload.channelId,
      MessageSid: payload.messageId,
      MessageSidFull: payload.messageId,
      Timestamp: tsMs,
      OriginatingChannel: payload.channelId,
      OriginatingTo: payload.chatId,
    });
    // 把消息「记录到会话里」方便 agent 记住上下文
    await channelRuntime.session.recordInboundSession({
      storePath,
      sessionKey: route.sessionKey,
      ctx: ctxPayload,
      onRecordError: (err: unknown) => {
        api.logger.error(`Pufferfish inbound: record session failed: ${String(err)}`);
      },
    });
    // 把消息派发给
    await channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg: api.config,
      dispatcherOptions: {
        deliver,
        onError: (err: unknown, info: { kind: string }) => {
          api.logger.error(`Pufferfish inbound: dispatch failed (${info.kind}): ${String(err)}`);
        },
      },
    });
  };

  /** 关闭 WS、从 channel 运行时表移除、清本地 Map */
  const disconnectAccount = (accountId: string): void => {
    const runtime = runtimeConnections.get(accountId);
    if (!runtime) return;
    api.logger.info(`关闭 Pufferfish WebSocket [账号: ${accountId}]`);
    runtime.wsClient.disconnect();
    removeRuntimeAccount(accountId);
    runtimeConnections.delete(accountId);
  };

  /**
   * 为单个账号建立或复用 WebSocket：若连接参数未变则只更新 token 与 sync_config；
   * 若曾断开则重新 connect，避免「仅刷新 token 却永远不连」的死锁。
   */
  const connectAccount = (account: PufferfishAccount): void => {
    const existing = runtimeConnections.get(account.accountId);
    if (
      existing &&
      existing.account.apiUrl === account.apiUrl &&
      existing.account.wsUrl === account.wsUrl &&
      existing.account.botUserId === account.botUserId
    ) {
      existing.account = account;
      existing.wsClient.updateAccount(account);
      setRuntimeAccount(account);
      // 已建立 WS 时仅刷新运行 token，不必重连。
      if (existing.wsClient.isOpen()) {
        sendSyncConfig(account, existing.wsClient);
        return;
      }
      // 曾失败/未连上时不能 return：否则下一次重新加载配置时会因为“仅 token 变化”而永远不连。
      existing.wsClient.connect().catch((error) => {
        api.logger.error(`连接 Pufferfish WebSocket 失败 [账号: ${account.accountId}]:`, error);
      });
      return;
    }
    if (existing) {
      disconnectAccount(account.accountId);
    }

    const wsClient = new PufferfishWebSocketClient(account);
    const adapter = new MessageAdapter();

    wsClient.on('connected', () => {
      api.logger.info(
        `Pufferfish WebSocket 已连接 [accountId: ${account.accountId}] [botUserId: ${account.botUserId}]`,
      );
      sendSyncConfig(account, wsClient);
    });

    wsClient.on('disconnected', () => {
      api.logger.warn(
        `Pufferfish WebSocket 已断开 [accountId: ${account.accountId}] [botUserId: ${account.botUserId}]`,
      );
    });

    wsClient.on('error', (error) => {
      api.logger.error(
        `Pufferfish WebSocket 错误 [accountId: ${account.accountId}] [botUserId: ${account.botUserId}]:`,
        error,
      );
    });

    wsClient.on('message', async (msg) => {
      try {
        api.logger.debug(`收到 Pufferfish 消息: ${msg.messageId}`);
        const openclawMsg = adapter.toOpenClawMessage(msg);
        await ingestIncomingMessage({
          account,
          channelId: 'pufferfish',
          accountId: account.accountId,
          chatId: msg.chatId,
          senderId: msg.userId.toString(),
          messageId: msg.messageId,
          message: openclawMsg,
          timestamp: msg.timestamp,
        });
      } catch (error) {
        const errMsg = error instanceof Error ? (error.stack ?? error.message) : String(error);
        api.logger.error(
          `处理 Pufferfish 消息失败 [accountId: ${account.accountId}] [botUserId: ${account.botUserId}] [messageId: ${
            msg?.messageId ?? 'unknown'
          }]: ${errMsg}; raw=${JSON.stringify(msg)}`,
        );
      }
    });

    runtimeConnections.set(account.accountId, { account, wsClient });
    setRuntimeAccount(account);
    wsClient.connect().catch((error) => {
      api.logger.error(`连接 Pufferfish WebSocket 失败 [账号: ${account.accountId}]:`, error);
    });
  };

  /** 与配置列表对齐：新增/更新连接，配置里已禁用的账号从运行时移除 */
  const applyAccounts = (accounts: PufferfishAccount[]): void => {
    const nextIds = new Set<string>();
    for (const account of accounts) {
      if (!account.enabled) continue;
      nextIds.add(account.accountId);
      connectAccount(account);
    }
    for (const accountId of runtimeConnections.keys()) {
      if (!nextIds.has(accountId)) {
        disconnectAccount(accountId);
      }
    }
  };

  /**
   * 通过 botUid 直连服务端，换取当前机器人自己的运行 token。
   * 一个 botUid 就是一只独立机器人，因此不会和其它机器人串线。
   */
  const loadBotAccounts = async (): Promise<void> => {
    const accounts: PufferfishAccount[] = [];
    for (const [rawAccountId, botConfig] of Object.entries(botConfigs)) {
      const accountId = String(rawAccountId).trim();
      const apiUrl = String(botConfig?.apiUrl ?? '').trim();
      const botUid = String(botConfig?.botUid ?? accountId).trim();
      const privateKey = String((botConfig as any)?.privateKey ?? '').trim();
      const enabled = botConfig?.enabled ?? true;
      if (!enabled || !apiUrl || !botUid) {
        continue;
      }
      try {
        if (!privateKey) {
          throw new Error('缺少 privateKey（PEM），无法进行 connect 签名认证');
        }
        const account = await PufferfishAPIClient.connectBot(apiUrl, botUid, privateKey);
        account.accountId = accountId;
        account.botUid = botUid;
        accounts.push(account);
      } catch (error) {
        const msg = error instanceof Error ? (error.stack ?? error.message) : String(error);
        api.logger.error(`Pufferfish bot 连接失败 [accountId=${accountId}] [botUid=${botUid}]: ${msg}`);
      }
    }
    applyAccounts(accounts);
  };

  api.logger.info('Pufferfish Channel 运行在 bot 直连模式（challenge + privateKey -> /v1/ai-bot/connect）');
  loadBotAccounts().catch((error) => {
    const msg = error instanceof Error ? (error.stack ?? error.message) : String(error);
    api.logger.error('加载机器人配置失败:', msg);
  });

  // 网关退出时释放所有连接，避免进程悬挂或重复注册
  api.on('gateway_stop', () => {
    for (const accountId of runtimeConnections.keys()) {
      disconnectAccount(accountId);
    }
  });
}
