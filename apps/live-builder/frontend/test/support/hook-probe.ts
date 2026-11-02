import { type ComponentType, h, render } from "preact";
import { act } from "preact/test-utils";

/**
 * Preact's real hooks and effects with nothing to draw. The app has no DOM
 * library, and a probe component that returns `null` needs none: only a
 * `document` that exists. `probeRoot()` puts that stub in place and hands back
 * a root to render probes into; `restore()` unmounts and puts the document back.
 */
export function probeRoot() {
  const documentBefore = Object.getOwnPropertyDescriptor(
    globalThis,
    "document",
  );
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {},
  });
  const root = {} as HTMLElement;
  const unmount = () => act(() => render(null, root));
  const restores: (() => void)[] = [];
  return {
    /** Renders the probe with these props, inside `act`: its effects have run. */
    show: <Props>(probe: ComponentType<Props>, props: Props) =>
      act(() => {
        render(h(probe as ComponentType<object>, props as object), root);
      }),
    unmount,
    /**
     * Makes the window keep the listeners the page adds to it, and drop the
     * ones it removes, as a window does (`restore()` gives it back as it was):
     * the list is the page's listeners as they are now.
     */
    windowListeners(): WindowListener[] {
      const registered: WindowListener[] = [];
      const { addEventListener, removeEventListener } = globalThis;
      globalThis.addEventListener = ((
        type: string,
        listener: WindowListener["listener"],
        capture?: unknown,
      ) => void registered.push({ type, listener, capture })) as never;
      globalThis.removeEventListener = ((
        type: string,
        listener: WindowListener["listener"],
      ) => {
        const at = registered.findIndex((entry) =>
          entry.type === type && entry.listener === listener
        );
        if (at >= 0) registered.splice(at, 1);
      }) as never;
      restores.push(() => {
        globalThis.addEventListener = addEventListener;
        globalThis.removeEventListener = removeEventListener;
      });
      return registered;
    },
    async restore() {
      await unmount();
      restores.forEach((restore) => restore());
      if (documentBefore) {
        Object.defineProperty(globalThis, "document", documentBefore);
      } else {
        Reflect.deleteProperty(globalThis, "document");
      }
    },
  };
}

/** A listener the page gave its window, with how it asked to be called. */
export interface WindowListener {
  type: string;
  listener: (event: Record<string, unknown>) => void;
  capture: unknown;
}
