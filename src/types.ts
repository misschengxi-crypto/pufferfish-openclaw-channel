/**
 * Pufferfish 消息类型定义
 * 从 Pufferfish 服务器接收的消息格式
 */
export interface PufferfishMessage {
  messageId: string;  // 消息唯一ID
  chatId: string;     // 会话ID（私聊或群聊）
  userId: number;     // 发送者用户ID
  type: 'text' | 'image' | 'file' | 'audio' | 'video';  // 消息类型
  content: string;    // 消息内容（文本内容或文件URL）
  metadata?: Record<string, any>;  // 额外元数据（如文件名、文件大小等）
  timestamp: number;  // 消息时间戳（Unix时间戳，秒）
  isStream?: boolean; // 是否为流式消息
  streamEnd?: boolean; // 流式消息是否结束
}

/**
 * Pufferfish 账号配置
 * OpenClaw 配置文件中的账号配置项
 */
export interface PufferfishAccount {
  accountId: string;   // 账号ID，默认与 botUid 一致
  enabled: boolean;    // 是否启用
  apiUrl: string;      // Pufferfish HTTP API 地址
  wsUrl: string;       // Pufferfish WebSocket 地址
  botUserId: number;   // 机器人用户ID
  /** OpenClaw 对外使用的机器人标识 */
  botUid?: string;
  token: string;       // 机器人 AccessToken（BotSendMessage / WebSocket 共用）
}

/**
 * 机器人在 OpenClaw 侧的运行时配置（用于下发 sync_config）。
 */
export interface PufferfishBotProfile {
  systemPrompt?: string;     // 机器人定位
  skills?: string[];         // 启用技能列表
}

/** 单个机器人配置。一个 botUid 就是一只独立机器人。 */
export interface PufferfishBotConfig {
  enabled?: boolean;
  apiUrl: string;
  botUid?: string;
  /** Ed25519 私钥（PEM），用于 connect challenge 签名换取运行 token */
  privateKey?: string;
}

/**
 * OpenClaw 消息格式
 * 传递给 OpenClaw Agent 的消息格式
 */
export interface OpenClawMessage {
  text?: string;       // 文本内容
  imageUrl?: string;   // 图片URL
  fileUrl?: string;    // 文件URL
  fileName?: string;   // 文件名
  metadata?: Record<string, any>;  // 元数据
}

/**
 * 发送消息请求
 * 调用 Pufferfish API 发送消息的请求格式
 */
export interface SendMessageRequest {
  chatId: string;      // 目标会话ID
  type: 'text' | 'image' | 'file';  // 消息类型
  content: string;     // 消息内容
  metadata?: Record<string, any>;   // 额外元数据
}

/**
 * 发送消息响应
 * Pufferfish API 返回的响应格式
 */
export interface SendMessageResponse {
  messageId: string;   // 消息ID
  timestamp: number;   // 发送时间戳
}
