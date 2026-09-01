/**
 * Display formatting. Every helper takes the nullable shape the property contract
 * actually uses and renders a visible placeholder for absent data, because "unknown" is
 * information a roofing salesperson needs — a blank cell reads as a bug.
 */

/** Rendered wherever the dataset has no value. Asserted on by the e2e suite. */
export const NOT_AVAILABLE = 'Not available';

const currency = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

const decimal = new Intl.NumberFormat('en-US');

export function formatCurrency(value: number | null | undefined): string {
  return value === null || value === undefined ? NOT_AVAILABLE : currency.format(value);
}

export function formatNumber(value: number | null | undefined, unit = ''): string {
  if (value === null || value === undefined) return NOT_AVAILABLE;
  return unit ? `${decimal.format(value)} ${unit}` : decimal.format(value);
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return NOT_AVAILABLE;
  const parsed = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return NOT_AVAILABLE;
  return parsed.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export function formatYears(value: number | null | undefined): string {
  if (value === null || value === undefined) return NOT_AVAILABLE;
  const rounded = Math.round(value * 10) / 10;
  return `${rounded} ${rounded === 1 ? 'year' : 'years'}`;
}

export function formatMiles(value: number): string {
  return `${(Math.round(value * 100) / 100).toFixed(2)} mi`;
}

export function formatCoordinates(latitude: number, longitude: number): string {
  return `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
}

export function humanisePropertyType(value: string): string {
  return value
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
