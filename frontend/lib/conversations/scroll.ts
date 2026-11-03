export interface ScrollBox {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export interface ScrollMemory {
  top: number;
  following: boolean;
}

/** A reader this close to the end keeps following new messages. */
export const FOLLOW_DISTANCE = 90;

export function isFollowingLatest(box: ScrollBox): boolean {
  return box.scrollHeight - box.scrollTop - box.clientHeight < FOLLOW_DISTANCE;
}

/**
 * Where a conversation rests after a render: on the latest message, at the bottom
 * just above the composer, unless the reader scrolled back through the history.
 * `shown` marks a conversation that just appeared (opened, switched or revealed),
 * whose remembered place is restored. `null` leaves the reader where they are.
 */
export function restingScrollTop(
  box: ScrollBox,
  input: { shown: boolean; memory?: ScrollMemory; following: boolean },
): number | null {
  const latest = Math.max(0, box.scrollHeight - box.clientHeight);
  if (input.shown) {
    return input.memory && !input.memory.following
      ? Math.min(input.memory.top, latest)
      : latest;
  }
  return input.following ? latest : null;
}

/**
 * The reading position of one conversation view across renders. A list that is
 * hidden or unmounted (a closed panel) forgets nothing: its next reveal restores
 * the reader's place, or the latest message when they were following.
 */
export function createScrollKeeper() {
  const memory = new Map<string, ScrollMemory>();
  let rendered: string | null = null;
  let following = true;
  return {
    settle(box: ScrollBox | null, key: string, active: boolean) {
      if (!box || !active) {
        rendered = null;
        return;
      }
      const shown = rendered !== key;
      const remembered = memory.get(key);
      if (shown) {
        following = remembered?.following ?? true;
        rendered = key;
      }
      const top = restingScrollTop(box, {
        shown,
        memory: remembered,
        following,
      });
      if (top !== null) box.scrollTop = top;
    },
    record(box: ScrollBox, key: string) {
      following = isFollowingLatest(box);
      memory.set(key, { top: box.scrollTop, following });
    },
  };
}
