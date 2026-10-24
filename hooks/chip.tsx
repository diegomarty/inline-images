// The surface module of a chip: it says when the pointer is on it, so the hooks module shows its
// picture in a card, and hides it when the pointer leaves; and when it is clicked, so the hooks
// module opens the picture.
import type { ClientModule } from 'claude-code'

/** `label`, the chip's text; none (or no props), an unpainted region over a row the engine draws. */
type Props = { label?: string } | null

const REPEAT_MS = 50

const Chip: ClientModule<Props, { isOver: boolean; isPressed?: boolean }> = (props, surface) => {
  const label = props?.label
  // Above or left of the region is outside it; below or right says nothing in one not laid out yet (0 by 0).
  const isInside = (x: number, y: number) => x >= 0 && y >= 0 && (surface.columns === 0 || (x < surface.columns && y < surface.rows))
  surface.onPointer(event => {
    // A click is the left button let go over the chip it went down on.
    if (event.type === 'down') {
      if (event.button === 'left') surface.setState({ isOver: true, isPressed: true })
      return
    }
    if (event.type === 'up') {
      const isOver = isInside(event.x, event.y)
      // Let go outside, after a press held the pointer here: it left.
      if (surface.state?.isPressed && isOver) surface.post({ isOver: true, isClicked: true })
      else if (!isOver) surface.post({ isOver: false })
      surface.setState({ isOver })
      return
    }
    // A move over the chip says so again: a card hidden while the pointer stayed comes back. One
    // held here by a press reports moves outside it too: those say it left.
    const isOver = event.type !== 'leave' && (event.type === 'enter' || isInside(event.x, event.y))
    surface.post({ isOver })
    if (isOver !== (surface.state?.isOver ?? false)) surface.setState({ isOver, isPressed: surface.state?.isPressed })
    // Going straight from one chip to the next, the leave and the enter post in one frame, and the
    // later replaces the other: the enter says so again a frame on.
    if (event.type === 'enter') {
      const stop = surface.every(REPEAT_MS, () => {
        stop()
        if (surface.state?.isOver) surface.post({ isOver: true })
      })
    }
  })
  const { Box, Text } = surface.elements
  if (label === undefined) return <Box />
  return <Text color="claude" inverse={surface.state?.isOver === true}>{label}</Text>
}

export default Chip
