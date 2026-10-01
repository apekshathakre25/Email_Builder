import { cn } from '../../lib/cn';

/**
 * Data table.
 *
 * Header cells stick to the top of the scroll container, which is what makes the
 * long recipient-file and test-result lists readable without a fixed-height hack.
 */

export function TableScroll({ maxHeight = '70vh', className, children }) {
  return (
    <div className={cn('min-w-0 overflow-auto rounded-md border border-line', className)} style={{ maxHeight }}>
      {children}
    </div>
  );
}

export function Table({ className, children }) {
  return (
    <table className={cn('w-full border-collapse text-base', className)}>{children}</table>
  );
}

export function Thead({ className, children }) {
  return <thead className={cn('sticky top-0 z-10', className)}>{children}</thead>;
}

export function Th({ align = 'left', className, children, ...rest }) {
  return (
    <th
      scope="col"
      className={cn(
        'border-b border-line bg-ink-50 px-3 py-2.5',
        'text-xs font-semibold uppercase tracking-wide text-ink-600 whitespace-nowrap',
        align === 'center' && 'text-center',
        align === 'right' && 'text-right',
        align === 'left' && 'text-left',
        className
      )}
      {...rest}
    >
      {children}
    </th>
  );
}

export function Tbody({ className, children }) {
  return <tbody className={className}>{children}</tbody>;
}

export function Tr({ className, children, ...rest }) {
  return (
    <tr
      className={cn(
        'border-b border-line last:border-b-0 transition-colors duration-[120ms] ease-standard hover:bg-brand-50/60',
        className
      )}
      {...rest}
    >
      {children}
    </tr>
  );
}

export function Td({ align = 'left', className, children, ...rest }) {
  return (
    <td
      className={cn(
        'px-3 py-2.5 align-top text-base text-ink-700',
        align === 'center' && 'text-center',
        align === 'right' && 'text-right',
        className
      )}
      {...rest}
    >
      {children}
    </td>
  );
}

/* Cell content helpers — the `.cell-*` classes from the old stylesheet. */

export function CellPrimary({ className, children, ...rest }) {
  return (
    <div className={cn('font-semibold text-ink-800', className)} {...rest}>
      {children}
    </div>
  );
}

export function CellSub({ className, children, ...rest }) {
  return (
    <div className={cn('text-xs text-muted', className)} {...rest}>
      {children}
    </div>
  );
}

export function CellMono({ className, children, ...rest }) {
  return (
    <code
      className={cn('rounded-sm bg-surface-muted px-1.5 py-0.5 font-mono text-xs text-ink-700', className)}
      {...rest}
    >
      {children}
    </code>
  );
}

export function CellActions({ className, children }) {
  return <div className={cn('flex items-center justify-center gap-1.5', className)}>{children}</div>;
}

/**
 * Empty / loading placeholder that spans the table.
 *
 * Takes the column count so the cell actually spans the table; the old markup
 * hardcoded colspan values that drifted when a column was added.
 */
export function TableEmpty({ colSpan, icon = 'fa-inbox', title, children, loading = false }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-4 py-12">
        <div className="flex flex-col items-center gap-2 text-center text-muted">
          <i
            className={cn('fa-solid text-2xl text-ink-300', loading ? 'fa-spinner fa-spin' : icon)}
            aria-hidden="true"
          />
          {title ? <p className="font-semibold text-ink-600">{title}</p> : null}
          {children ? <p className="max-w-md text-base">{children}</p> : null}
        </div>
      </td>
    </tr>
  );
}


