/** Layer-neutral error helpers shared across mcp/rag/ops. */

/** Extracts a message from an unknown thrown value. */
export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
