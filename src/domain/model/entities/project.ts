/** Stable project identity and manifest, independent of local storage. */
export interface ModelProject {
  schemaVersion: 1;
  id: string;
  name: string;
  sourcesDirectory: "sources";
}

export function modelProjectName(name: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 63) {
    throw new Error(
      "Project name must contain 1–63 lowercase letters, digits or hyphens",
    );
  }
  return name;
}
