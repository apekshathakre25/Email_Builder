/**
 * Joins class names, dropping anything falsy.
 *
 * Hand-rolled rather than pulling in clsx: it is four lines, and the components here
 * never need conditional-object syntax.
 */
export function cn(...values) {
  return values.filter(Boolean).join(' ');
}
