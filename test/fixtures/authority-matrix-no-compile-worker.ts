/** Trap source compilation before the real process entry reads its first job.
 * The production validator, pin checks and projector remain unchanged. */
import { ToolkitCompiler } from "../../src/adapters/out/sysml-toolkit/compilation/compiler.ts";
import { runAuthorityMatrixProcess } from "../../src/adapters/out/sysml-toolkit/projections/authority-matrix/process.ts";

const forbiddenCompilation = (): never => {
  throw new Error("Matrix projection attempted forbidden Toolkit compilation");
};
ToolkitCompiler.prototype.compile = forbiddenCompilation;
ToolkitCompiler.prototype.recipe = forbiddenCompilation;

await runAuthorityMatrixProcess();
