import assert from "node:assert/strict";
import type {
  AuthorityMatrix,
  MatrixCell,
  MatrixColumn,
  MatrixRow,
} from "../../../domain/governance/records/authority-matrix.ts";
import type { ModelBoard } from "../../../domain/model/records/board.ts";
import { ModelAttentionService } from "./attention.ts";

const VERSION = `commit:${"a".repeat(40)}`;

function column(
  id: MatrixColumn["id"],
  group: MatrixColumn["group"],
): MatrixColumn {
  return {
    kind: "fixed",
    id: id as never,
    group: group as never,
    capability: id,
    inTypedPlan: true,
    label: id,
    mode: "execute",
    tier: "core",
    order: 0,
    typedScope: "none",
    doc: "",
  } as MatrixColumn;
}

function cell(overrides: Partial<MatrixCell>): MatrixCell {
  return {
    row: "builder@Unit::a",
    column: "candidate.admit",
    state: "allowed",
    display: "allowed",
    basis: "declared",
    sources: [],
    codes: [],
    origin: "compiler",
    ...overrides,
  };
}

function row(overrides: Partial<MatrixRow>): MatrixRow {
  return {
    id: "builder@Unit::a",
    kind: "software",
    role: "builder",
    label: "Builder",
    unit: "Unit::a",
    declared: true,
    ...overrides,
  };
}

function matrix(overrides: Partial<AuthorityMatrix> = {}): AuthorityMatrix {
  return {
    schema: "ase.authority-matrix/1",
    version: VERSION as AuthorityMatrix["version"],
    model: {
      name: "test",
      sourceDigest: "digest",
      toolkit: "test",
      authoritySchema: "owner-modeled",
      units: [],
    },
    groups: [],
    rows: [],
    columns: [],
    cells: [],
    delegations: [],
    diagnostics: [],
    caveats: ["ADOPTED_VERSION_ONLY"],
    summary: {
      byState: {
        allowed: 0,
        "propose-only": 0,
        denied: 0,
        inherited: 0,
        delegated: 0,
      },
      uncertain: 0,
      hostRule: 0,
      byRow: {},
      coordinates: { checked: 0, mismatches: 0 },
    },
    digest: "matrix-digest",
    ...overrides,
  };
}

function board(overrides: Partial<ModelBoard> = {}): ModelBoard {
  return {
    schema: "ase.board/1",
    meta: {
      model: "test",
      mode: "ase",
      sourceDigest: "digest",
      diagnostics: [],
      digest: "board-digest",
    },
    columns: [],
    links: [],
    index: {},
    ...overrides,
  };
}

function service(overrides: {
  matrix?: AuthorityMatrix | Error;
  board?: ModelBoard | Error;
  diagnostics?: Array<Record<string, unknown>> | Error;
  counts?: { matrix: number; board: number; doctor: number };
} = {}) {
  const counts = overrides.counts ?? { matrix: 0, board: 0, doctor: 0 };
  return new ModelAttentionService({
    matrix: {
      read: () => {
        counts.matrix++;
        return overrides.matrix instanceof Error
          ? Promise.reject(overrides.matrix)
          : Promise.resolve(overrides.matrix ?? matrix());
      },
    },
    board: {
      read: () => {
        counts.board++;
        return overrides.board instanceof Error
          ? Promise.reject(overrides.board)
          : Promise.resolve(overrides.board ?? board());
      },
    },
    diagnostics: {
      list: () => {
        counts.doctor++;
        return overrides.diagnostics instanceof Error
          ? Promise.reject(overrides.diagnostics)
          : Promise.resolve({
            version: VERSION,
            sourceDigest: "digest",
            diagnostics: overrides.diagnostics ?? [],
          } as never);
      },
    },
  });
}

const unhealthyBoard = board({
  columns: [{
    id: "guarantees",
    title: "Guarantees",
    rule: {},
    items: [
      {
        id: "req-1",
        element: "el-req",
        keyword: "requirement",
        title: "Be safe",
        qname: "Unit::BeSafe",
        file: "a.sysml",
        line: 1,
        kind: "requirement",
        satisfiedBy: [],
      },
      {
        id: "con-1",
        element: "el-con",
        keyword: "constraint",
        title: "Stay bounded",
        qname: "Unit::StayBounded",
        file: "a.sysml",
        line: 2,
        kind: "constraint",
        inForce: false,
      },
      {
        id: "req-ok",
        element: "el-ok",
        keyword: "requirement",
        title: "Be owned",
        qname: null,
        file: "a.sysml",
        line: 3,
        kind: "requirement",
        satisfiedBy: ["owner-1"],
      },
    ],
  }],
});

const selfApprovalMatrix = matrix({
  rows: [row({ element: { role: "holder", elementId: "el-builder" } })],
  columns: [
    column("tool.invoke", "tools"),
    column("candidate.admit", "admission"),
    column("candidate.review", "admission"),
  ],
  cells: [
    cell({ column: "tool.invoke", codes: ["ADMISSION_BY_BUILDER"] }),
    cell({ column: "candidate.admit" }),
  ],
});

Deno.test("attention composes matrix diagnostics, self-approval, board health and doctor codes", async () => {
  const attention = await service({
    matrix: matrix({
      ...selfApprovalMatrix,
      diagnostics: [{
        code: "MEMORY_REVIEW_UNREACHABLE",
        severity: "warning",
        context: { unit: "Unit::a" },
        recovery: "Declare a memory reviewer.",
      }, {
        code: "OWNER_IMPLICIT",
        severity: "info",
        context: {},
        recovery: "Declare the owner.",
      }],
    }),
    board: unhealthyBoard,
    diagnostics: [{
      code: "LOOP_WITHOUT_BUDGET",
      severity: "warning",
      finding: "absent",
      message: "No budget.",
      masked: false,
      elementId: "el-unit",
    }],
  }).read(VERSION);
  assert.equal(attention.schema, "ase.model-attention/1");
  assert.equal(attention.version, VERSION);
  assert.equal(attention.count, attention.items.length);
  assert.match(attention.digest, /^[a-f0-9]{64}$/);
  const byCode = new Map(attention.items.map((item) => [item.code, item]));
  assert.equal(
    byCode.get("MEMORY_REVIEW_UNREACHABLE")?.source,
    "authority-matrix",
  );
  assert.equal(byCode.get("MEMORY_REVIEW_UNREACHABLE")?.target.page, "rights");
  assert.equal(
    byCode.has("OWNER_IMPLICIT"),
    false,
    "info matrix diagnostics stay out",
  );
  assert.deepEqual(byCode.get("TOOL_SELF_APPROVAL"), {
    code: "TOOL_SELF_APPROVAL",
    severity: "warning",
    source: "authority-matrix",
    context: { row: "builder@Unit::a", unit: "Unit::a", label: "Builder" },
    recovery:
      "Declare an operator able to review candidates, or stop this operator admitting its own tool candidates.",
    target: { page: "rights", elementId: "el-builder" },
  });
  assert.equal(
    byCode.get("REQUIREMENT_WITHOUT_OWNER")?.target.elementId,
    "el-req",
  );
  assert.equal(byCode.get("REQUIREMENT_WITHOUT_OWNER")?.severity, "warning");
  assert.equal(byCode.get("CONSTRAINT_INACTIVE")?.severity, "info");
  assert.equal(byCode.get("CONSTRAINT_INACTIVE")?.target.page, "requirements");
  assert.equal(byCode.get("LOOP_WITHOUT_BUDGET")?.source, "doctor");
  assert.equal(byCode.get("LOOP_WITHOUT_BUDGET")?.target.page, "team");
  for (const item of attention.items) {
    assert.ok(item.code && item.recovery && item.target.page);
    assert.ok(["error", "warning", "info"].includes(item.severity));
  }
  // Exact list, not a code map: a wrongly flagged owned requirement
  // (req-ok) or in-force constraint would add an entry here.
  assert.deepEqual(
    attention.items.map((item) => [item.code, item.target.elementId ?? null]),
    [
      ["MEMORY_REVIEW_UNREACHABLE", null],
      ["TOOL_SELF_APPROVAL", "el-builder"],
      ["REQUIREMENT_WITHOUT_OWNER", "el-req"],
      ["LOOP_WITHOUT_BUDGET", "el-unit"],
      ["CONSTRAINT_INACTIVE", "el-con"],
    ],
  );
});

Deno.test("attention respects doctor masks and excludes info findings", async () => {
  const attention = await service({
    diagnostics: [
      {
        code: "LOOP_WITHOUT_BUDGET",
        severity: "warning",
        finding: "absent",
        message: "masked",
        masked: true,
        elementId: "el-a",
      },
      {
        code: "SELF_ADMINISTERED",
        severity: "info",
        finding: "present",
        message: "info",
        masked: false,
        elementId: "el-a",
      },
      {
        code: "NO_ACCOUNTABLE_OWNER",
        severity: "warning",
        finding: "indeterminate",
        message: "visible",
        masked: false,
        elementId: "el-a",
      },
    ],
  }).read(VERSION);
  assert.deepEqual(attention.items.map((item) => item.code), [
    "NO_ACCOUNTABLE_OWNER",
  ]);
  // Exact merged order across sources: doctor error before matrix warning
  // before board info, whatever each source returned first.
  const merged = await service({
    matrix: matrix({
      diagnostics: [{
        code: "MEMORY_REVIEW_UNREACHABLE",
        severity: "warning",
        context: {},
        recovery: "Fix the matrix.",
      }],
    }),
    board: unhealthyBoard,
    diagnostics: [{
      code: "DOCTOR_ERROR",
      severity: "error",
      finding: "absent",
      message: "Doctor error.",
      masked: false,
      elementId: "el-doc",
    }],
  }).read(VERSION);
  assert.deepEqual(
    merged.items.map((item) => `${item.code}:${item.severity}:${item.source}`),
    [
      "DOCTOR_ERROR:error:doctor",
      "MEMORY_REVIEW_UNREACHABLE:warning:authority-matrix",
      "REQUIREMENT_WITHOUT_OWNER:warning:board",
      "CONSTRAINT_INACTIVE:info:board",
    ],
  );
});

Deno.test("attention gives no self-approval item when a reviewer can review", async () => {
  const withReviewer = matrix({
    ...selfApprovalMatrix,
    rows: [
      ...selfApprovalMatrix.rows,
      row({
        id: "reviewer@Unit::b",
        role: "reviewer",
        label: "Reviewer",
        unit: "Unit::b",
      }),
    ],
    cells: [
      ...selfApprovalMatrix.cells,
      cell({ row: "reviewer@Unit::b", column: "candidate.review" }),
    ],
  });
  const attention = await service({ matrix: withReviewer }).read(VERSION);
  assert.equal(
    attention.items.some((item) => item.code === "TOOL_SELF_APPROVAL"),
    false,
  );
});

Deno.test("attention sort is deterministic whatever the source item order", async () => {
  const shuffled = board({
    columns: [{
      id: "guarantees",
      title: "Guarantees",
      rule: {},
      items: [...unhealthyBoard.columns[0].items].reverse(),
    }],
  });
  const first = await service({ board: unhealthyBoard }).read(VERSION);
  const second = await service({ board: shuffled }).read(VERSION);
  assert.deepEqual(first.items, second.items);
  assert.equal(first.digest, second.digest);
});

Deno.test("attention recomposes on every read; the sources cache themselves", async () => {
  const counts = { matrix: 0, board: 0, doctor: 0 };
  const svc = service({ counts, board: unhealthyBoard });
  const reads = await Promise.all(
    Array.from({ length: 6 }, () => svc.read(VERSION)),
  );
  await svc.read(VERSION);
  // No cache of its own in this composition: the fakes have no cache, so
  // every read reaches them. The real matrix/board services cache their
  // projections (and evict failures) underneath.
  assert.equal(counts.matrix, 7);
  assert.equal(counts.board, 7);
  assert.equal(counts.doctor, 7);
  assert.ok(reads.every((entry) => entry.digest === reads[0].digest));
  assert.equal(svc.peekCount(VERSION), reads[0].count);
});

Deno.test("a healthy model gives an empty attention list", async () => {
  const attention = await service().read(VERSION);
  assert.deepEqual(attention.items, []);
  assert.equal(attention.count, 0);
});

Deno.test("an unavailable source gives a coded item and keeps the other sources", async () => {
  const failure = Object.assign(new Error("matrix slow"), {
    code: "TOOLKIT_TIMEOUT",
  });
  const attention = await service({
    matrix: failure as never,
    board: unhealthyBoard,
  }).read(VERSION);
  const unavailable = attention.items.find((item) =>
    item.code === "ATTENTION_SOURCE_UNAVAILABLE"
  );
  assert.equal(unavailable?.source, "authority-matrix");
  assert.equal(unavailable?.severity, "warning");
  assert.deepEqual(unavailable?.context, {
    source: "authority-matrix",
    failureCode: "TOOLKIT_TIMEOUT",
    message: "matrix slow",
  });
  assert.ok(
    attention.items.some((item) => item.code === "REQUIREMENT_WITHOUT_OWNER"),
    "board items survive a matrix failure",
  );
});

Deno.test("attention refuses a mutable version before reading any source", async () => {
  const counts = { matrix: 0, board: 0, doctor: 0 };
  const svc = service({ counts });
  await assert.rejects(() => svc.read("branch:main"), {
    code: "INVALID_REQUEST",
  });
  assert.deepEqual(counts, { matrix: 0, board: 0, doctor: 0 });
  assert.equal(svc.peekCount("branch:main"), undefined);
});

const codedError = (code: string) =>
  Object.assign(new Error(`failure ${code}`), { code });

function flakyService(failing: "authority-matrix" | "board" | "doctor") {
  const calls = { matrix: 0, board: 0, doctor: 0 };
  const failOnce = (key: keyof typeof calls) => {
    calls[key]++;
    return calls[key] === 1
      ? Promise.reject(codedError("TOOLKIT_TIMEOUT"))
      : undefined;
  };
  const svc = new ModelAttentionService({
    matrix: {
      read: () =>
        (failing === "authority-matrix" && failOnce("matrix")) ||
        Promise.resolve(matrix()),
    },
    board: {
      read: () =>
        (failing === "board" && failOnce("board")) ||
        Promise.resolve(board()),
    },
    diagnostics: {
      list: () =>
        (failing === "doctor" && failOnce("doctor")) ||
        Promise.resolve({
          version: VERSION,
          sourceDigest: "digest",
          diagnostics: [],
        } as never),
    },
  });
  return { svc, calls };
}

Deno.test("a transient failure is never cached and never retained for the event", async () => {
  for (const source of ["authority-matrix", "board", "doctor"] as const) {
    const { svc, calls } = flakyService(source);
    const first = await svc.read(VERSION);
    assert.equal(first.count, 1, source);
    assert.equal(first.items[0].code, "ATTENTION_SOURCE_UNAVAILABLE");
    assert.equal(first.items[0].source, source);
    assert.equal(
      svc.peekCount(VERSION),
      undefined,
      `${source}: a degraded count is not retained`,
    );
    const second = await svc.read(VERSION);
    assert.deepEqual(
      second.items,
      [],
      `${source}: recovered source is healthy`,
    );
    assert.equal(second.count, 0);
    assert.equal(svc.peekCount(VERSION), 0);
    const total = calls.matrix + calls.board + calls.doctor;
    assert.ok(total >= 2);
    assert.equal(
      source === "authority-matrix"
        ? calls.matrix
        : source === "board"
        ? calls.board
        : calls.doctor,
      2,
      `${source}: the failing source was read again`,
    );
  }
});

Deno.test("a board failure and a doctor failure each give one coded item and keep the other sources", async () => {
  const withMatrix = matrix({
    diagnostics: [{
      code: "MEMORY_REVIEW_UNREACHABLE",
      severity: "warning",
      context: { unit: "Unit::a" },
      recovery: "Declare a memory reviewer.",
    }],
  });
  const doctorDiag = {
    code: "LOOP_WITHOUT_BUDGET",
    severity: "warning",
    finding: "absent",
    message: "No budget.",
    masked: false,
    elementId: "el-unit",
  };
  const boardFailed = await service({
    matrix: withMatrix,
    board: codedError("BOARD_UNAVAILABLE") as never,
    diagnostics: [doctorDiag],
  }).read(VERSION);
  const boardItem = boardFailed.items.find((item) =>
    item.code === "ATTENTION_SOURCE_UNAVAILABLE"
  );
  assert.equal(boardItem?.source, "board");
  assert.equal(boardItem?.target.page, "requirements");
  assert.deepEqual(boardItem?.context, {
    source: "board",
    failureCode: "BOARD_UNAVAILABLE",
    message: "failure BOARD_UNAVAILABLE",
  });
  assert.ok(
    boardFailed.items.some((item) => item.code === "MEMORY_REVIEW_UNREACHABLE"),
  );
  assert.ok(
    boardFailed.items.some((item) => item.code === "LOOP_WITHOUT_BUDGET"),
  );

  const doctorFailed = await service({
    matrix: withMatrix,
    board: unhealthyBoard,
    diagnostics: codedError("DOCTOR_UPSTREAM_FAILURE") as never,
  }).read(VERSION);
  const doctorItem = doctorFailed.items.find((item) =>
    item.code === "ATTENTION_SOURCE_UNAVAILABLE"
  );
  assert.equal(doctorItem?.source, "doctor");
  assert.equal(doctorItem?.target.page, "team");
  assert.equal(
    (doctorItem?.context as { failureCode?: unknown }).failureCode,
    "DOCTOR_UPSTREAM_FAILURE",
  );
  assert.ok(
    doctorFailed.items.some((item) =>
      item.code === "MEMORY_REVIEW_UNREACHABLE"
    ),
  );
  assert.ok(
    doctorFailed.items.some((item) =>
      item.code === "REQUIREMENT_WITHOUT_OWNER"
    ),
  );
});

Deno.test("only infrastructure failures become items; strict codes are rethrown", async () => {
  for (
    const code of [
      "MODEL_VERSION_NOT_FOUND",
      "NOT_FOUND",
      "INVALID_PROJECTION_X",
      "MODEL_VERSION_MISMATCH",
      "SOME_UNKNOWN_CODE",
    ]
  ) {
    await assert.rejects(
      () => service({ matrix: codedError(code) as never }).read(VERSION),
      { code },
      code,
    );
    await assert.rejects(
      () => service({ board: codedError(code) as never }).read(VERSION),
      { code },
      code,
    );
    await assert.rejects(
      () => service({ diagnostics: codedError(code) as never }).read(VERSION),
      { code },
      code,
    );
  }
  for (
    const code of [
      "TOOLKIT_TIMEOUT",
      "BOARD_UNAVAILABLE",
      "DOCTOR_UPSTREAM_FAILURE",
      "MATRIX_TOOLKIT_FAILED",
    ]
  ) {
    const attention = await service({ board: codedError(code) as never })
      .read(VERSION);
    assert.equal(attention.count, 1, code);
    assert.equal(attention.items[0].code, "ATTENTION_SOURCE_UNAVAILABLE");
    assert.equal(
      (attention.items[0].context as { failureCode?: unknown }).failureCode,
      code,
    );
  }
  const noCode = await service({ board: new Error("boom") as never }).read(
    VERSION,
  );
  assert.equal(noCode.items[0].code, "ATTENTION_SOURCE_UNAVAILABLE");
  assert.equal(
    (noCode.items[0].context as { failureCode?: unknown }).failureCode,
    "SOURCE_READ_FAILED",
  );
});

Deno.test("digest covers the version and the items, masks included", async () => {
  const diagnostics = [{
    code: "LOOP_WITHOUT_BUDGET",
    severity: "warning",
    finding: "absent",
    message: "No budget.",
    masked: false,
    elementId: "el-unit",
  }];
  const svc = service({ diagnostics });
  const visible = await svc.read(VERSION);
  assert.equal(visible.count, 1);
  diagnostics[0].masked = true;
  const masked = await svc.read(VERSION);
  assert.equal(masked.count, 0);
  assert.notEqual(masked.digest, visible.digest, "masking changes the digest");
  diagnostics[0].masked = false;
  const restored = await svc.read(VERSION);
  assert.equal(restored.digest, visible.digest);
  const otherVersion = await svc.read(`commit:${"c".repeat(40)}`);
  assert.deepEqual(otherVersion.items, visible.items);
  assert.notEqual(
    otherVersion.digest,
    visible.digest,
    "the version is part of the digest",
  );
  const different = await service({ board: unhealthyBoard }).read(VERSION);
  assert.notEqual(different.digest, visible.digest);
});

Deno.test("peekCount counts doctor items and warm resolves only once it can answer", async () => {
  const withDoctor = await service({
    diagnostics: [{
      code: "LOOP_WITHOUT_BUDGET",
      severity: "warning",
      finding: "absent",
      message: "No budget.",
      masked: false,
      elementId: "el-unit",
    }],
  }).read(VERSION);
  assert.equal(withDoctor.count, 1);

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const svc = new ModelAttentionService({
    matrix: { read: () => Promise.resolve(matrix()) },
    board: { read: () => Promise.resolve(board()) },
    diagnostics: {
      list: async () => {
        await gate;
        return {
          version: VERSION,
          sourceDigest: "digest",
          diagnostics: [],
        } as never;
      },
    },
  });
  assert.equal(svc.peekCount(VERSION), undefined);
  let warmDone = false;
  const warming = svc.warm(VERSION).then(() => {
    warmDone = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(warmDone, false, "warm waits for the read it started");
  assert.equal(svc.peekCount(VERSION), undefined);
  release();
  await warming;
  assert.equal(warmDone, true);
  assert.equal(svc.peekCount(VERSION), 0, "a real zero is retained");
});

Deno.test("peekCount includes doctor items after a direct service read", async () => {
  const svc = service({
    diagnostics: [{
      code: "LOOP_WITHOUT_BUDGET",
      severity: "warning",
      finding: "absent",
      message: "No budget.",
      masked: false,
      elementId: "el-unit",
    }],
  });
  const attention = await svc.read(VERSION);
  assert.equal(attention.count, 1);
  assert.equal(svc.peekCount(VERSION), attention.count);
});

Deno.test("an older read does not overwrite a newer count", async () => {
  let doctorCalls = 0;
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const svc = new ModelAttentionService({
    matrix: { read: () => Promise.resolve(matrix()) },
    board: { read: () => Promise.resolve(board()) },
    diagnostics: {
      list: async () => {
        doctorCalls++;
        if (doctorCalls === 1) {
          await firstGate;
          return {
            version: VERSION,
            sourceDigest: "digest",
            diagnostics: [{
              code: "LOOP_WITHOUT_BUDGET",
              severity: "warning",
              finding: "absent",
              message: "old",
              masked: false,
              elementId: "el-old",
            }],
          } as never;
        }
        return {
          version: VERSION,
          sourceDigest: "digest",
          diagnostics: [],
        } as never;
      },
    },
  });
  const older = svc.read(VERSION);
  const newer = await svc.read(VERSION);
  assert.equal(newer.count, 0);
  assert.equal(svc.peekCount(VERSION), 0);
  releaseFirst();
  const olderResult = await older;
  assert.equal(olderResult.count, 1);
  assert.equal(
    svc.peekCount(VERSION),
    0,
    "the older read must not overwrite the newer count",
  );
});

Deno.test("self-approval negative cases give no item, inherited admission does", async () => {
  const baseRows = selfApprovalMatrix.rows;
  const baseCells = selfApprovalMatrix.cells;
  const cases: Array<
    { name: string; matrix: AuthorityMatrix; expected: boolean }
  > = [
    {
      name: "human operator",
      matrix: matrix({
        ...selfApprovalMatrix,
        rows: [
          row({
            kind: "human",
            element: { role: "holder", elementId: "el-h" },
          }),
        ],
      }),
      expected: false,
    },
    {
      name: "admission denied",
      matrix: matrix({
        ...selfApprovalMatrix,
        cells: [
          baseCells[0],
          cell({ column: "candidate.admit", state: "denied" }),
        ],
      }),
      expected: false,
    },
    {
      name: "admission propose-only",
      matrix: matrix({
        ...selfApprovalMatrix,
        cells: [
          baseCells[0],
          cell({ column: "candidate.admit", state: "propose-only" }),
        ],
      }),
      expected: false,
    },
    {
      name: "admission unusable",
      matrix: matrix({
        ...selfApprovalMatrix,
        cells: [
          baseCells[0],
          cell({
            column: "candidate.admit",
            codes: ["RIGHT_WITHOUT_OBJECT"],
          }),
        ],
      }),
      expected: false,
    },
    {
      name: "no builder admission on a tools column",
      matrix: matrix({
        ...selfApprovalMatrix,
        cells: [cell({ column: "tool.invoke", codes: [] }), baseCells[1]],
      }),
      expected: false,
    },
    {
      name: "builder admission only outside tools columns",
      matrix: matrix({
        ...selfApprovalMatrix,
        cells: [
          cell({ column: "candidate.admit", codes: ["ADMISSION_BY_BUILDER"] }),
        ],
      }),
      expected: false,
    },
    {
      name: "inherited admission is usable",
      matrix: matrix({
        ...selfApprovalMatrix,
        cells: [
          baseCells[0],
          cell({ column: "candidate.admit", state: "inherited" }),
        ],
      }),
      expected: true,
    },
  ];
  for (const entry of cases) {
    const attention = await service({ matrix: entry.matrix }).read(VERSION);
    assert.equal(
      attention.items.some((item) => item.code === "TOOL_SELF_APPROVAL"),
      entry.expected,
      entry.name,
    );
    assert.equal(baseRows.length, 1);
  }
});

Deno.test("board health negative cases give no item", async () => {
  const healthy = board({
    columns: [
      {
        id: "guarantees",
        title: "Guarantees",
        rule: {},
        items: [
          {
            id: "req-ok",
            element: "el-ok",
            keyword: "requirement",
            title: "Be owned",
            qname: null,
            file: "a.sysml",
            line: 1,
            kind: "requirement",
            satisfiedBy: ["owner-1"],
          },
          {
            id: "con-ok",
            element: "el-con-ok",
            keyword: "constraint",
            title: "In force",
            qname: null,
            file: "a.sysml",
            line: 2,
            kind: "constraint",
            inForce: true,
          },
        ],
      },
      {
        id: "rules",
        title: "Rules",
        rule: {},
        items: [
          {
            id: "req-other",
            element: "el-other",
            keyword: "requirement",
            title: "Outside guarantees",
            qname: null,
            file: "a.sysml",
            line: 3,
            kind: "requirement",
            satisfiedBy: [],
          },
          {
            id: "con-other",
            element: "el-con-other",
            keyword: "constraint",
            title: "Outside guarantees",
            qname: null,
            file: "a.sysml",
            line: 4,
            kind: "constraint",
            inForce: false,
          },
        ],
      },
    ],
  });
  const attention = await service({ board: healthy }).read(VERSION);
  assert.deepEqual(attention.items, []);
  assert.equal(attention.count, 0);
});
