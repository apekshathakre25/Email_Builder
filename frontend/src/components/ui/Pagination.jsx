import { cn } from '../../lib/cn';
import { Button } from './Button';
import { Select } from './Field';

/**
 * Windowed pagination, reproducing the algorithm from backend/views/file-upload.ejs:
 * a five-page window around the current page, with first/last shortcuts and
 * ellipses when the window does not reach the ends.
 */
function pageWindow(currentPage, totalPages) {
  let start = Math.max(1, currentPage - 2);
  const end = Math.min(totalPages, start + 4);
  if (end - start < 4) start = Math.max(1, end - 4);

  const pages = [];
  for (let page = start; page <= end; page += 1) pages.push(page);
  return { pages, start, end };
}

export function Pagination({ page, totalPages, onPageChange, className }) {
  if (!totalPages || totalPages <= 1) return null;

  const { pages, start, end } = pageWindow(page, totalPages);

  return (
    <nav className={cn('flex flex-wrap items-center gap-1', className)} aria-label="Pagination">
      <Button
        size="icon"
        variant="outline"
        onClick={() => onPageChange(page - 1)}
        disabled={page <= 1}
        aria-label="Previous page"
      >
        <i className="fa-solid fa-chevron-left" aria-hidden="true" />
      </Button>

      {start > 1 ? (
        <>
          <Button size="icon" variant="outline" onClick={() => onPageChange(1)} aria-label="Page 1">
            1
          </Button>
          {start > 2 ? (
            <span className="px-1 text-muted" aria-hidden="true">
              …
            </span>
          ) : null}
        </>
      ) : null}

      {pages.map((candidate) => (
        <Button
          key={candidate}
          size="icon"
          variant={candidate === page ? 'primary' : 'outline'}
          onClick={() => onPageChange(candidate)}
          aria-label={`Page ${candidate}`}
          aria-current={candidate === page ? 'page' : undefined}
        >
          {candidate}
        </Button>
      ))}

      {end < totalPages ? (
        <>
          {end < totalPages - 1 ? (
            <span className="px-1 text-muted" aria-hidden="true">
              …
            </span>
          ) : null}
          <Button
            size="icon"
            variant="outline"
            onClick={() => onPageChange(totalPages)}
            aria-label={`Page ${totalPages}`}
          >
            {totalPages}
          </Button>
        </>
      ) : null}

      <Button
        size="icon"
        variant="outline"
        onClick={() => onPageChange(page + 1)}
        disabled={page >= totalPages}
        aria-label="Next page"
      >
        <i className="fa-solid fa-chevron-right" aria-hidden="true" />
      </Button>
    </nav>
  );
}

export function RowsPerPage({ value, onChange, options = [10, 15, 25, 50, 100], id = 'rows-per-page' }) {
  return (
    <div className="flex shrink-0 items-center gap-2 text-sm text-muted">
      <label htmlFor={id} className="whitespace-nowrap">
        Rows per page
      </label>
      <Select
        id={id}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="w-auto py-1 text-sm"
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </Select>
    </div>
  );
}
