/** A picture as the mod read it: its size in pixels and how many frames it has, or why it has none. */
export type Picture = { width: number; height: number; frames: number } | { error: string }

/** What `/images` set for the session: whether pictures are drawn, and how large. */
export type View = { isOn: boolean; size: 'small' | 'medium' | 'large' }

declare module 'claude-code' {
  interface PluginState {
    'inline-images': {
      /** Each picture read so far, by its key: `read:<tool_use_id>`, `paste:<N>` or `file:<path>`. */
      pictures: Record<string, Picture>
      /** The `[Image #N]` ids in the prompt box, in the order typed: the strip above it. */
      draft: number[]
      /** What `/images` set: pictures drawn or not, and their size; kept across a reload. */
      view: View
    }
  }
}
