import { useEffect, useId, useMemo, useRef, useState } from 'react';

import { cn } from '../../lib/cn';

/** Accessible searchable single-select backed only by the supplied option IDs. */
export function SearchableSelect({
  id,
  value,
  options,
  onChange,
  placeholder = 'Select an option',
  disabled = false,
  'aria-describedby': ariaDescribedBy
}) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const listboxId = `${inputId}-listbox`;
  const rootRef = useRef(null);
  const inputRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [activeId, setActiveId] = useState(null);

  const selected = options.find((option) => option.id === value) ?? null;
  const filtered = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    if (!needle) return options;
    return options.filter((option) => option.name.toLocaleLowerCase().includes(needle));
  }, [options, search]);

  useEffect(() => {
    const handlePointerDown = (event) => {
      if (!rootRef.current?.contains(event.target)) {
        setOpen(false);
        setSearch('');
        setActiveId(null);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, []);

  const openList = () => {
    if (disabled) return;
    setSearch('');
    setOpen(true);
    setActiveId(selected?.id ?? options[0]?.id ?? null);
  };

  const choose = (option) => {
    onChange(option.id);
    setOpen(false);
    setSearch('');
    setActiveId(null);
    inputRef.current?.focus();
  };

  const moveActive = (direction) => {
    if (!open) {
      openList();
      return;
    }
    if (filtered.length === 0) return;

    const currentIndex = filtered.findIndex((option) => option.id === activeId);
    const nextIndex =
      currentIndex < 0
        ? direction > 0
          ? 0
          : filtered.length - 1
        : (currentIndex + direction + filtered.length) % filtered.length;
    setActiveId(filtered[nextIndex].id);
  };

  const handleKeyDown = (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveActive(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }

    if (event.key === 'Enter' && open) {
      event.preventDefault();
      const option = filtered.find((item) => item.id === activeId) ?? filtered[0];
      if (option) choose(option);
      return;
    }

    if (event.key === 'Escape' && open) {
      event.preventDefault();
      setOpen(false);
      setSearch('');
      setActiveId(null);
      return;
    }

    if (event.key === 'Tab') {
      setOpen(false);
      setSearch('');
      setActiveId(null);
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <div className="relative">
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-activedescendant={open && activeId !== null ? `${listboxId}-${activeId || 'default'}` : undefined}
          aria-describedby={ariaDescribedBy}
          autoComplete="off"
          disabled={disabled}
          value={open ? search : (selected?.name ?? '')}
          placeholder={placeholder}
          onFocus={openList}
          onClick={openList}
          onChange={(event) => {
            const nextSearch = event.target.value;
            setSearch(nextSearch);
            setOpen(true);
            const needle = nextSearch.trim().toLocaleLowerCase();
            const nextFiltered = needle
              ? options.filter((option) => option.name.toLocaleLowerCase().includes(needle))
              : options;
            setActiveId(nextFiltered[0]?.id ?? null);
          }}
          onKeyDown={handleKeyDown}
          className={cn(
            'w-full rounded-md border border-line bg-surface px-3 py-2 pr-9 text-base leading-base text-body',
            'placeholder:text-ink-400 transition-colors duration-[120ms] ease-standard',
            'hover:border-line-strong focus:border-brand-500 focus:outline-none focus:ring-3 focus:ring-brand-200',
            'disabled:cursor-not-allowed disabled:bg-surface-muted disabled:text-muted'
          )}
        />
        <i
          className={cn(
            'fa-solid fa-chevron-down pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted',
            open && 'rotate-180'
          )}
          aria-hidden="true"
        />
      </div>

      {open ? (
        <ul
          id={listboxId}
          role="listbox"
          className="absolute z-30 mt-1 max-h-60 w-full overflow-auto rounded-md border border-line bg-surface p-1 shadow-lg"
        >
          {filtered.length === 0 ? (
            <li className="px-3 py-2 text-sm text-muted" role="status">
              No matching patterns.
            </li>
          ) : (
            filtered.map((option) => {
              const optionDomId = `${listboxId}-${option.id || 'default'}`;
              const isActive = option.id === activeId;
              const isSelected = option.id === value;

              return (
                <li
                  key={option.id || 'default'}
                  id={optionDomId}
                  role="option"
                  aria-selected={isSelected}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActiveId(option.id)}
                  onClick={() => choose(option)}
                  className={cn(
                    'flex cursor-pointer flex-col rounded-sm px-3 py-2 text-sm',
                    isActive ? 'bg-brand-50 text-brand-800' : 'text-ink-700 hover:bg-ink-50'
                  )}
                >
                  <span className="flex items-center justify-between gap-2 font-medium">
                    {option.name}
                    {isSelected ? <i className="fa-solid fa-check text-brand-500" aria-hidden="true" /> : null}
                  </span>
                  {option.description ? (
                    <span className="mt-0.5 text-xs text-muted">{option.description}</span>
                  ) : null}
                </li>
              );
            })
          )}
        </ul>
      ) : null}
    </div>
  );
}
