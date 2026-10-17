/** 用户选择的翻译方向。 */
export type Direction = "en-zh" | "zh-en" | "auto";

/** 实际发给模型的目标语言。 */
export type TargetLanguage = "中文" | "英文";

/** 插件设置。 */
export interface Settings {
  apiKey: string;
  baseUrl: string;
  model: string;
  direction: Direction;
}

/** 网页总结结构。 */
export interface SummaryResult {
  title: string;
  overview: string;
  points: string[];
}

/** 聊天消息。 */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}
