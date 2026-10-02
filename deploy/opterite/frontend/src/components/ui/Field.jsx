import { forwardRef, useId } from 'react';
import { cn } from '../../lib/cn';

/**
 * Form controls.
 *
 * `Field` owns the id/label/hint/error wiring rather than leaving it to each caller,
 * because the old markup did it by hand on roughly twenty inputs and the
 * aria-describedby links were inconsistent as a result. Here a hint or an error is
 * described automatically, and an error implies aria-invalid.
 */

const CONTROL_BASE = cn(
  'w-full rounded-md border border-line bg-surface text-body',
  'px-3 py-2 text-base leading-base',
  'placeholder:text-ink-400',
  'transition-colors duration-[120ms] ease-standard',
  'hover:border-line-strong',
  'focus:border-brand-500 focus:outline-none focus:ring-3 focus:ring-brand-200',
  'disabled:cursor-not-allowed disabled:bg-surface-muted disabled:text-muted',
  // read-only rather than disabled is how the rate inputs are locked mid-campaign,
  // so it needs a visible treatment of its own: clearly not editable, but plainly
  // still holding a value that will be submitted.
  'read-only:bg-surface-muted read-only:text-ink-600 read-only:cursor-not-allowed'
);

export function Field({ label, htmlFor, hint, error, required, className, labelAction, children }) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {label ? (
        <div className={cn('flex items-center gap-2', labelAction && 'justify-between')}>
          <label htmlFor={htmlFor} className="text-sm font-semibold text-ink-700">
            {label}
            {required ? (
              <span className="ml-0.5 text-danger-500" aria-hidden="true">
                *
              </span>
            ) : null}
          </label>
          {labelAction}
        </div>
      ) : null}

      {children}

      {error ? (
        <span className="text-xs text-danger-600" role="alert">
          {error}
        </span>
      ) : hint ? (
        <span className="text-xs text-muted">{hint}</span>
      ) : null}
    </div>
  );
}

/**
 * Label + control in one call.
 *
 * Generates an id when none is given so every control is labelled even when the
 * caller has no reason to name it.
 */
export function TextField({
  label,
  hint,
  error,
  required,
  id,
  className,
  labelAction,
  as: Component = Input,
  ...controlProps
}) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const describedBy = error ? `${fieldId}-error` : hint ? `${fieldId}-hint` : undefined;

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {label ? (
        <div className={cn('flex items-center gap-2', labelAction && 'justify-between')}>
          <label htmlFor={fieldId} className="text-sm font-semibold text-ink-700">
            {label}
            {required ? (
              <span className="ml-0.5 text-danger-500" aria-hidden="true">
                *
              </span>
            ) : null}
          </label>
          {labelAction}
        </div>
      ) : null}

      <Component
        id={fieldId}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        {...controlProps}
      />

      {error ? (
        <span id={`${fieldId}-error`} className="text-xs text-danger-600" role="alert">
          {error}
        </span>
      ) : hint ? (
        <span id={`${fieldId}-hint`} className="text-xs text-muted">
          {hint}
        </span>
      ) : null}
    </div>
  );
}

export const Input = forwardRef(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cn(CONTROL_BASE, className)} {...rest} />;
});

export const Textarea = forwardRef(function Textarea({ className, rows = 3, ...rest }, ref) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      className={cn(CONTROL_BASE, 'resize-y min-h-[70px] font-sans', className)}
      {...rest}
    />
  );
});

export const Select = forwardRef(function Select({ className, children, ...rest }, ref) {
  return (
    <select ref={ref} className={cn(CONTROL_BASE, 'cursor-pointer pr-8', className)} {...rest}>
      {children}
    </select>
  );
});

/** Input with a trailing button, used for the password reveal toggles. */
export function InputGroup({ className, children }) {
  return (
    <div
      className={cn(
        'flex items-stretch rounded-md border border-line bg-surface',
        'focus-within:border-brand-500 focus-within:ring-3 focus-within:ring-brand-200',
        'hover:border-line-strong',
        className
      )}
    >
      {children}
    </div>
  );
}

export const GroupedInput = forwardRef(function GroupedInput({ className, ...rest }, ref) {
  return (
    <input
      ref={ref}
      className={cn(
        'min-w-0 flex-1 rounded-md border-0 bg-transparent px-3 py-2 text-base text-body',
        'placeholder:text-ink-400 focus:outline-none',
        'disabled:cursor-not-allowed disabled:text-muted',
        className
      )}
      {...rest}
    />
  );
});

export function InputAddon({ className, children, ...rest }) {
  return (
    <button
      type="button"
      // Excluded from the tab order deliberately: a reveal toggle between a password
      // field and the next field is a trap for keyboard users, who want to move on
      // rather than to inspect what they just typed.
      tabIndex={-1}
      className={cn(
        'flex shrink-0 items-center justify-center px-3 text-muted',
        'border-l border-line hover:text-ink-700 hover:bg-ink-50',
        'transition-colors duration-[120ms] ease-standard rounded-r-md',
        className
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

/** Radio / checkbox sets. */
export function ChoiceSet({ legend, className, children }) {
  return (
    <fieldset className={cn('flex flex-col gap-1.5 border-0 p-0 m-0', className)}>
      <legend className="mb-1.5 p-0 text-sm font-semibold text-ink-700">{legend}</legend>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </fieldset>
  );
}

export function Choice({ id, name, value, checked, onChange, label, disabled, type = 'radio' }) {
  return (
    <label
      htmlFor={id}
      className={cn(
        'inline-flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5',
        'text-base font-medium transition-colors duration-[120ms] ease-standard',
        checked
          ? 'border-brand-500 bg-brand-50 text-brand-700'
          : 'border-line bg-surface text-ink-600 hover:border-line-strong hover:bg-ink-50',
        disabled && 'cursor-not-allowed opacity-55'
      )}
    >
      <input
        id={id}
        type={type}
        name={name}
        value={value}
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        className="h-3.5 w-3.5 accent-brand-500"
      />
      {label}
    </label>
  );
}

export function CheckboxField({ id, label, checked, onChange, disabled, hint, icon }) {
  return (
    <div className="flex flex-col gap-1">
      <label
        htmlFor={id}
        className={cn(
          'inline-flex items-center gap-2 text-base font-medium',
          disabled ? 'cursor-not-allowed text-muted' : 'cursor-pointer text-ink-700'
        )}
      >
        <input
          id={id}
          type="checkbox"
          checked={checked}
          onChange={onChange}
          disabled={disabled}
          className="h-4 w-4 accent-brand-500"
        />
        {icon ? <i className={cn('fa-solid', icon)} aria-hidden="true" /> : null}
        {label}
      </label>
      {hint ? <span className="pl-6 text-xs text-muted">{hint}</span> : null}
    </div>
  );
}

/** Grouped set of related fields — the old <fieldset class="field-group">. */
export function FieldGroup({ title, icon, className, children, actions }) {
  return (
    <fieldset
      className={cn(
        'm-0 flex min-w-0 flex-col gap-4 rounded-lg border border-line bg-surface p-4 shadow-xs',
        className
      )}
    >
      <legend className="flex items-center gap-2 px-1 text-md font-semibold text-ink-800">
        {icon ? <i className={cn('fa-solid', icon, 'text-brand-500')} aria-hidden="true" /> : null}
        {title}
      </legend>
      {actions}
      {children}
    </fieldset>
  );
}

/** Auto-fitting row of fields, matching `.field-row`. */
export function FieldRow({ className, children, min = '180px' }) {
  return (
    <div
      className={cn('grid gap-3', className)}
      style={{ gridTemplateColumns: `repeat(auto-fit, minmax(${min}, 1fr))` }}
    >
      {children}
    </div>
  );
}
