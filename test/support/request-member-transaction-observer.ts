import { AsyncLocalStorage } from "node:async_hooks";

const classes = new Set([
  "PrismaClientKnownRequestError",
  "PrismaClientUnknownRequestError",
  "PrismaClientInitializationError",
  "PrismaClientValidationError",
  "PrismaClientRustPanicError",
  "DriverAdapterError",
  "AggregateError",
  "Error",
]);
const codes = new Set([
  "P1000",
  "P1001",
  "P1002",
  "P1008",
  "P1017",
  "P2010",
  "P2024",
  "P2028",
  "P2034",
  "40001",
  "40P01",
  "55P03",
  "57014",
  "53300",
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "08007",
  "08P01",
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
]);
const limit = 8;
interface Failure {
  class: string;
  code: string;
}
interface Summary {
  /** Saturates at eight; the list retains the first eight failures only. */
  count: number;
  failures: Failure[];
}

function classify(error: unknown): Failure {
  try {
    const value = error as { name?: unknown; code?: unknown } | null;
    const name = value?.name, code = value?.code;
    return {
      class: typeof name === "string" && classes.has(name) ? name : "other",
      code: typeof code === "string" && codes.has(code) ? code : "other",
    };
  } catch {
    return { class: "other", code: "other" };
  }
}

/** Test-only observation of the case-8 member-right read. Never retains an
 * error, arguments, results, messages, stacks, causes or driver metadata. */
export function observeMemberRightTransactions(
  client: { $transaction: (...args: never[]) => unknown },
  report: (summary: Summary) => void,
) {
  const context = new AsyncLocalStorage<"case-8-member-right">();
  const descriptor = Object.getOwnPropertyDescriptor(client, "$transaction");
  const original = client.$transaction;
  const failures: Failure[] = [];
  const reject = (error: unknown): never => {
    if (failures.length < limit) failures.push(classify(error));
    throw error;
  };
  const wrapped = function (this: unknown, ...args: unknown[]) {
    if (context.getStore() !== "case-8-member-right") {
      return Reflect.apply(original, this, args);
    }
    try {
      return Promise.resolve(Reflect.apply(original, this, args)).catch(reject);
    } catch (error) {
      return reject(error);
    }
  };
  Object.defineProperty(client, "$transaction", {
    configurable: true,
    enumerable: descriptor?.enumerable ?? false,
    writable: true,
    value: wrapped,
  });
  let restored = false;
  return {
    async read<T>(operation: () => Promise<T>): Promise<T> {
      try {
        return await context.run("case-8-member-right", operation);
      } catch (error) {
        try {
          report({
            count: failures.length,
            failures: failures.map((f) => ({ ...f })),
          });
        } catch { /* Reporting cannot replace the original public error. */ }
        throw error;
      }
    },
    restore() {
      if (restored) return;
      if (descriptor) {
        // Prisma's proxy may describe a virtual method without its actual value.
        Object.defineProperty(client, "$transaction", {
          ...descriptor,
          ...("value" in descriptor ? { value: original } : {}),
        });
      } else Reflect.deleteProperty(client, "$transaction");
      context.disable();
      restored = true;
    },
  };
}
