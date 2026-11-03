# Frozen ASE source compatibility fixture

These SysML files retain the exact bytes of `models/*.sysml` at commit
`f94e723c3d8baf87718870c78262dbc926fac785`, before the Assembly technical
namespace change. They are compatibility evidence, not new defaults.

`sysml-product-compatibility_test.ts` compiles and reopens this source family
with the real pinned native Toolkit, checks stable source/IR/provenance digests
and native identities, and applies an approved edit without renaming its
libraries. The legacy information bootstrap is qualified separately with the
exact retained `ase-modeling` skill asset. Do not update these files to match
current product naming.

The seven fixed-hash source-value cases use the separate
`legacy-ase-authority-before-tool-admission.sysml`, from
`f3e7dee64969414e7f9605e586852f61c0f30b24`, because their original input
predates the inert ToolAdmissionPolicy declaration. Their expected digests
remain unchanged. `../skills/ase-modeling/SKILL.md` freezes the original skill
bytes for that bootstrap's content digest.
