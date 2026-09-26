/** What a tool call returns to the step loop. `status` is the HTTP status where there was one. */
export type ToolResult = { content: string; isError: boolean; status: number | null };
