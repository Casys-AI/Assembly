// Keep persisted ordering compatible with en-US and independent of the host locale.
export const persistedOrder = new Intl.Collator("en-US").compare;
