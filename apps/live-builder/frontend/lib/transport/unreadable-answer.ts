/**
 * An answer the host gave, and a page cannot use: the body is not what its
 * contract says, or it does not say which version of the model it describes.
 * Reading it again would read the same; `readProblemOf` tells it as invalid.
 */
export class UnreadableAnswer extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnreadableAnswer";
  }
}

/**
 * Where a body stopped being what its contract says, and what it should have
 * been. Each contract (the board, the authority matrix) names its own.
 */
export class ParseError extends UnreadableAnswer {
  constructor(readonly path: string, readonly expected: string) {
    super(`${path}: expected ${expected}`);
    this.name = "ParseError";
  }
}
