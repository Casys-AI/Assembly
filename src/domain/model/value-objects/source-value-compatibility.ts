type Raw = Record<string, unknown>;

/** Provider-specific interpretation supplied at the compiled-record boundary. */
export interface SourceValueCompatibility {
  arguments(
    expression: Raw,
    valuesByFeature: ReadonlyMap<string, Raw[]>,
    element: (id: string) => Raw,
    one: (value: unknown, context: string) => string,
  ): string[];
  implicitUpper(
    feature: Raw,
    byId: ReadonlyMap<string, Raw>,
    hasSubsetting: boolean,
  ): number | undefined;
}
