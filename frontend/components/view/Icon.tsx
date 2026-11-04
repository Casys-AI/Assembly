type Shape =
  | readonly ["path", string]
  | readonly ["circle", number, number, number]
  | readonly ["rect", number, number, number, number, number];

/**
 * The marks the pages of a place draw with, from the prototype's set: outline
 * strokes on a 24-pixel square, in the colour of the text around them. A page
 * names one; it never draws its own.
 */
const SHAPES = {
  person: [
    ["circle", 12, 8, 3.6],
    ["path", "M5 20c1.2-3.7 4-5.6 7-5.6s5.8 1.9 7 5.6"],
  ],
  wrench: [[
    "path",
    "M14.6 5.2a4 4 0 0 0-5 5.1L4.5 15.4l4.1 4.1 5.1-5.1a4 4 0 0 0 5.1-5l-2.6 2.6-2.4-.6-.6-2.4z",
  ]],
  book: [
    ["path", "M5 5.5h10.5a3 3 0 0 1 3 3V19H8a3 3 0 0 1-3-3z"],
    ["path", "M5 16a3 3 0 0 1 3-3h10.5"],
  ],
  eye: [
    [
      "path",
      "M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12z",
    ],
    ["circle", 12, 12, 2.6],
  ],
  archive: [
    ["rect", 4, 4.5, 16, 4.5, 1],
    ["path", "M5.5 9v10.5h13V9M10 13h4"],
  ],
  file: [
    ["path", "M6.5 3.5h7l4 4v13h-11z"],
    ["path", "M13.5 3.5v4h4M9 13h6M9 16.5h4"],
  ],
  key: [
    ["circle", 8, 12, 3.5],
    ["path", "M11.5 12H20M17 12v3M20 12v2"],
  ],
  arrows: [["path", "M4 8h13l-3-3M20 16H7l3 3"]],
  spark: [
    [
      "path",
      "M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1-5.1-1.9 5.1-1.9z",
    ],
    ["path", "M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"],
  ],
  cube: [
    ["path", "M12 3.8l7.5 4.1v8.2L12 20.2l-7.5-4.1V7.9z"],
    ["path", "M4.5 7.9L12 12l7.5-4.1M12 12v8.2"],
  ],
  shield: [
    ["path", "M12 3.5l7 2.8v5c0 4.3-2.9 7.6-7 9.2-4.1-1.6-7-4.9-7-9.2v-5z"],
    ["path", "M12 8.5v4M12 15.5v.3"],
  ],
  check: [
    ["circle", 12, 12, 8],
    ["path", "M8.5 12.5l2.4 2.4 4.6-5"],
  ],
  ring: [
    ["circle", 12, 12, 7.5],
    ["path", "M12 4.5a7.5 7.5 0 0 1 7.5 7.5"],
  ],
  dot: [
    ["circle", 12, 12, 7.5],
    ["circle", 12, 12, 1.5],
  ],
  open: [["path", "M9 5H5v14h14v-4M13 5h6v6M19 5l-8 8"]],
  lock: [
    ["rect", 6, 11, 12, 8.5, 1.5],
    ["path", "M8.5 11V8.5a3.5 3.5 0 0 1 7 0V11"],
  ],
  globe: [
    ["circle", 12, 12, 8],
    [
      "path",
      "M4 12h16M12 4c2.2 2.3 3.3 5 3.3 8s-1.1 5.7-3.3 8c-2.2-2.3-3.3-5-3.3-8s1.1-5.7 3.3-8z",
    ],
  ],
  bubble: [["path", "M5 5.5h14v10h-8.5L6 19v-3.5H5z"]],
} as const satisfies Record<string, readonly Shape[]>;

export type IconName = keyof typeof SHAPES;

export function Icon(
  { name, class: extra }: { name: IconName; class?: string },
) {
  return (
    <svg
      viewBox="0 0 24 24"
      class={extra ? `ic ${extra}` : "ic"}
      aria-hidden="true"
      focusable="false"
    >
      {SHAPES[name].map((shape, index) =>
        shape[0] === "path"
          ? <path key={index} d={shape[1]} />
          : shape[0] === "circle"
          ? <circle key={index} cx={shape[1]} cy={shape[2]} r={shape[3]} />
          : (
            <rect
              key={index}
              x={shape[1]}
              y={shape[2]}
              width={shape[3]}
              height={shape[4]}
              rx={shape[5]}
            />
          )
      )}
    </svg>
  );
}
