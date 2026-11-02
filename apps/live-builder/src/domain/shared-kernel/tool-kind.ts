/** Shared kernel: single owner of the implemented tool kinds. */
export const TOOL_KINDS = ["read_web_page", "read_web_page_outline"] as const;
export type ToolKind = typeof TOOL_KINDS[number];
