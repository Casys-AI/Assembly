import type {
  BoardGrant,
  BoardItem,
  BoardValue,
} from "../../../../src/domain/model/records/board.ts";

/**
 * What an item of the board declares under a name, read by its type: a value
 * of another type is not coerced into the one asked for (`"true"` is not
 * `true`), it is not there. The first declaration of a name wins.
 */

type Declaring = Pick<BoardItem, "values"> | undefined;

/** The value an item declares under `name`, whatever its type. */
export function valueOf(item: Declaring, name: string): BoardValue | undefined {
  return item?.values?.find((entry) => entry.name === name)?.value;
}

/** A declared text; a blank one is no declaration. */
export function textOf(item: Declaring, name: string): string | undefined {
  const value = valueOf(item, name);
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

export function flagOf(item: Declaring, name: string): boolean | undefined {
  const value = valueOf(item, name);
  return typeof value === "boolean" ? value : undefined;
}

/** A value that is a list of model-editing grants (an empty list is not one). */
export function isGrantList(
  value: BoardValue | undefined,
): value is readonly BoardGrant[] {
  return Array.isArray(value) && value.length > 0 &&
    value.every((entry) => typeof entry === "object");
}

/** A value that is a list of strings. */
export function isTextList(
  value: BoardValue | undefined,
): value is readonly string[] {
  return Array.isArray(value) &&
    value.every((entry) => typeof entry === "string");
}
