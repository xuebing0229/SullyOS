export const API_COST_UPDATED_EVENT =
  'sullyos:api-cost-updated';

export function emitApiCostUpdated(
  detail: {
    dateKey?: string;
    entryId?: string;
  } = {},
): void {
  if (
    typeof window
    === 'undefined'
  ) {
    return;
  }

  window.dispatchEvent(
    new CustomEvent(
      API_COST_UPDATED_EVENT,
      {
        detail,
      },
    ),
  );
}
