/** Real DOM for mounted component tests only; never imported by product code. */
import { Window } from "happy-dom";
import { replaceGlobals } from "./globals.ts";

export async function withMountedDom<T>(
  run: (document: Document) => Promise<T>,
): Promise<T> {
  const window = new Window({
    url: "http://127.0.0.1:4311/",
    settings: {
      enableJavaScriptEvaluation: false,
      disableJavaScriptFileLoading: true,
      enableCSSFileLoading: false,
      enableImageFileLoading: false,
      enableIframePageLoading: false,
      navigation: {
        disableMainFrameNavigation: true,
        disableChildFrameNavigation: true,
        disableChildPageNavigation: true,
      },
    },
  });
  const restore = replaceGlobals({
    window,
    document: window.document,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    SVGElement: window.SVGElement,
    Event: window.Event,
    MouseEvent: window.MouseEvent,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  });
  try {
    return await run(window.document as unknown as Document);
  } finally {
    try {
      await window.happyDOM.abort();
    } finally {
      try {
        window.close();
      } finally {
        restore();
      }
    }
  }
}
