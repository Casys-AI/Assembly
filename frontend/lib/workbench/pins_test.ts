import { deepStrictEqual, equal } from "node:assert/strict";
import { createPins } from "./pins.ts";

Deno.test("pins retain their legacy entry and save later choices under Assembly", () => {
  localStorage.clear();
  try {
    const legacy = '[ "native:case-a", "native:case-b" ]';
    localStorage.setItem("ase:pins:system", legacy);
    const pins = createPins();
    pins.load("system");
    deepStrictEqual(pins.ids.value, ["native:case-a", "native:case-b"]);
    equal(localStorage.getItem("assembly:pins:system"), legacy);
    pins.toggle("native:case-a");
    equal(localStorage.getItem("ase:pins:system"), legacy);
    const reopened = createPins();
    reopened.load("system");
    deepStrictEqual(reopened.ids.value, ["native:case-b"]);
    reopened.load("other-system");
    deepStrictEqual(reopened.ids.value, []);
  } finally {
    localStorage.clear();
  }
});

Deno.test("an existing empty Assembly pin list takes precedence over legacy pins", () => {
  localStorage.clear();
  try {
    localStorage.setItem("ase:pins:system", '["old"]');
    localStorage.setItem("assembly:pins:system", "[]");
    const pins = createPins();
    pins.load("system");
    deepStrictEqual(pins.ids.value, []);
    equal(localStorage.getItem("ase:pins:system"), '["old"]');
  } finally {
    localStorage.clear();
  }
});
