# 0003. One meaning per colour; magenta is the thing being followed

Status: accepted

## Decision
- Magenta: the key, transaction, message or token being followed. Nothing else is ever magenta.
- Amber: being compared. Blue: visited or on the path. Green: found, written or committed. Red with a dashed outline: removed, rejected, lost or aborted.
- Named pointers (head, tail, top, lo, hi, next, commit) use the neutral `shape: 'tag'`: white fill, ink outline, no hue.
- Categorical hues (for example Raft terms) must not look like any of the above; a teal was dropped for looking like "committed".
- State is never carried by colour alone: dashes, outlines and text carry it too.
- Tokens live in `src/styles.css`. Meaningful lines and borders are at least 3:1 against their background; text at least 4.5:1.

## Consequences
A reader learns the palette once and it holds on every page. Page authors sometimes want a colour for something else and cannot have it: use a tag, a label or a shape.
