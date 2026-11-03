import type {
  SkillDownload,
  SkillDownloadPort,
} from "../../../application/skills/ports.ts";
import {
  requireSkill,
  requireSkillContent,
  requireSkillUrl,
  SkillError,
  type SkillPolicy,
} from "../../../domain/skills/context-skills.ts";

export interface HttpsSkillDownloaderOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

/** Download instruction bytes only. No archive, link, import or command is run. */
export class HttpsSkillDownloader implements SkillDownloadPort {
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;

  constructor(options: HttpsSkillDownloaderOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    requireSkill(
      Number.isSafeInteger(this.#timeoutMs) && this.#timeoutMs >= 1 &&
        this.#timeoutMs <= 120_000,
      "invalid",
      "download timeout must be between 1 and 120000 milliseconds",
    );
  }

  async download(url: string, policy: SkillPolicy): Promise<SkillDownload> {
    const admitted = structuredClone(policy);
    const requestedUrl = requireSkillUrl(url, admitted).href;
    const controller = new AbortController();
    let response: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new SkillError("invalid", "skill download timed out"));
      }, this.#timeoutMs);
    });
    const cancel = () => {
      // Cancellation must not let an uncooperative transport extend the deadline.
      try {
        const result = reader ? reader.cancel() : response?.body?.cancel();
        void result?.catch(() => {});
      } catch { /* A transport may already have released its body. */ }
    };
    try {
      const pending = this.#fetch(requestedUrl, {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          accept:
            "text/markdown, text/plain;q=0.9, application/octet-stream;q=0.5",
        },
      });
      // A custom transport may ignore AbortSignal and resolve after the timeout.
      void pending.then((late) => {
        if (timedOut) void late.body?.cancel().catch(() => {});
      }, () => {});
      response = await Promise.race([pending, deadline]);
      requireSkill(
        !response.redirected &&
          !(response.status >= 300 && response.status < 400),
        "forbidden",
        "skill download redirects are not allowed",
      );
      const finalUrl = response.url ? new URL(response.url).href : requestedUrl;
      requireSkill(
        finalUrl === requestedUrl,
        "forbidden",
        "skill response does not match the requested URL",
      );
      requireSkill(response.ok, "invalid", "skill server returned an error");
      const mime = response.headers.get("content-type")?.split(";", 1)[0]
        ?.trim().toLowerCase();
      requireSkill(
        !mime || [
          "text/plain",
          "text/markdown",
          "text/x-markdown",
          "application/octet-stream",
        ].includes(mime),
        "invalid",
        "skill response must be raw instruction text",
      );
      const announced = response.headers.get("content-length");
      if (announced !== null) {
        requireSkill(
          /^\d+$/.test(announced) && Number.isSafeInteger(Number(announced)),
          "invalid",
          "invalid skill response length",
        );
        requireSkill(
          Number(announced) <= admitted.maxSkillBytes,
          "limit",
          "skill exceeds the byte limit",
        );
      }
      requireSkill(response.body, "invalid", "skill response has no body");
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let byteLength = 0;
      while (true) {
        const part = await Promise.race([reader.read(), deadline]);
        if (part.done) break;
        requireSkill(
          part.value instanceof Uint8Array,
          "invalid",
          "skill response contains invalid bytes",
        );
        byteLength += part.value.byteLength;
        requireSkill(
          byteLength <= admitted.maxSkillBytes,
          "limit",
          "skill exceeds the byte limit",
        );
        chunks.push(part.value.slice());
      }
      const bytes = new Uint8Array(byteLength);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
          .decode(bytes);
      } catch {
        throw new SkillError("invalid", "skill response is not valid UTF-8");
      }
      requireSkillContent(content, admitted.maxSkillBytes);
      return { content, requestedUrl, finalUrl, byteLength };
    } catch (error) {
      cancel();
      if (error instanceof SkillError) throw error;
      throw new SkillError(
        "invalid",
        timedOut ? "skill download timed out" : "skill download failed",
      );
    } finally {
      clearTimeout(timer);
      try {
        reader?.releaseLock();
      } catch {
        /* A transport ignoring cancellation may retain a pending read. */
      }
    }
  }
}
