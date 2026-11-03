import {
  canonicalProductName,
  legacyProductName,
  productNameInModel,
  productNameVariants,
  productSourceForModel,
  sameProductName,
} from "./sysml-product-names.ts";

function assert(value: unknown): asserts value {
  if (!value) throw new Error("Assertion failed");
}

Deno.test("product library aliases preserve exact native spellings and reject ambiguity", () => {
  assert(sameProductName("ASECore::Operator", "AssemblyCore::Operator"));
  assert(sameProductName("AssemblyAuthority", "ASEAuthority"));
  assert(
    !sameProductName("Customer::ASECore::Operator", "AssemblyCore::Operator"),
  );
  assert(canonicalProductName("APEContext::Policy") === "APEContext::Policy");
  assert(canonicalProductName("ASECustomer::Part") === "ASECustomer::Part");
  assert(
    legacyProductName("AssemblyLiveBuilder::liveBuilder") ===
      "ASELiveBuilder::liveBuilder",
  );
  assert(productNameVariants("ASECore").join() === "AssemblyCore,ASECore");
  assert(
    productNameInModel(
      [{ qualifiedName: "ASELiveBuilder" }],
      "AssemblyLiveBuilder::ReviewedCapabilityPromotion",
    ) === "ASELiveBuilder::ReviewedCapabilityPromotion",
  );
  const native = { qualifiedName: "ASECore::Operator", id: "native-old-id" };
  assert(
    productNameInModel([native], "AssemblyCore::Operator") ===
      native.qualifiedName,
  );
  assert(
    native.id === "native-old-id" &&
      native.qualifiedName === "ASECore::Operator",
  );
  try {
    productNameInModel(
      [native, { qualifiedName: "AssemblyCore::Operator" }],
      "ASECore::Operator",
    );
    throw new Error("Expected ambiguity");
  } catch (error) {
    assert(String(error).includes("Ambiguous product library declaration"));
  }
});

Deno.test("generated template library aliases preserve quoted metadata and comments", () => {
  const text =
    'part reviewer : AssemblyCore::Operator { attribute id = "AssemblyCore"; attribute label = "ASECore :: \\"AssemblyCore\\""; } // AssemblyCore\n/* ASECore */';
  const actual = productSourceForModel(text, [{ qualifiedName: "ASECore" }]);
  assert(
    actual ===
      text.replace(
        "part reviewer : AssemblyCore::Operator",
        "part reviewer : ASECore::Operator",
      ),
  );
});
