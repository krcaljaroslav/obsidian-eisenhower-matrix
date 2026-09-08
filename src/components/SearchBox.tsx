import { useEffect, useRef } from 'react';
import { Icon } from './Icon.tsx';

type Props = {
  open: boolean;
  query: string;
  /** Počet nalezených tasků. */
  matchCount: number;
  /** Pořadí aktuální shody, 1-based; 0 = žádná. */
  currentIndex: number;
  onOpen: () => void;
  onClose: () => void;
  onQueryChange: (query: string) => void;
  onNext: () => void;
  onPrev: () => void;
};

/**
 * Hledání napříč zobrazenými tasky. Zavřené je to jen ikona lupy (šetří
 * místo v hlavičce, hlavně na mobilu), po kliknutí se rozbalí input
 * s počítadlem „3/12" a tlačítky ▲ ▼ ✕ — ta jsou tu kvůli mobilu, kde
 * klávesové zkratky (Enter / Shift+Enter / Esc) nejsou po ruce.
 */
export function SearchBox({
  open,
  query,
  matchCount,
  currentIndex,
  onOpen,
  onClose,
  onQueryChange,
  onNext,
  onPrev,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={onOpen}
        className="em-search-toggle"
        title="Search tasks"
        aria-label="Search tasks"
      >
        <Icon name="search" className="em-search-icon" />
      </button>
    );
  }

  const noHits = query.trim() !== '' && matchCount === 0;

  return (
    <div className="em-search" role="search">
      <Icon name="search" className="em-search-icon" />
      <input
        ref={inputRef}
        type="text"
        className={`em-search-input ${noHits ? 'em-search-input-empty' : ''}`}
        placeholder="Search tasks…"
        value={query}
        aria-label="Search tasks"
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (e.shiftKey) onPrev();
            else onNext();
            return;
          }
          if (e.key === 'Escape') {
            // Bez stopPropagation by Esc zavřel rovnou celý Obsidian panel.
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
      />
      <span className="em-search-count" role="status" aria-live="polite">
        {query.trim() === ''
          ? ''
          : matchCount === 0
            ? 'no matches'
            : `${currentIndex}/${matchCount}`}
      </span>
      <button
        type="button"
        className="em-search-btn"
        onClick={onPrev}
        disabled={matchCount === 0}
        title="Previous match (Shift+Enter)"
        aria-label="Previous match"
      >
        <Icon name="chevron-up" className="em-search-icon" />
      </button>
      <button
        type="button"
        className="em-search-btn"
        onClick={onNext}
        disabled={matchCount === 0}
        title="Next match (Enter)"
        aria-label="Next match"
      >
        <Icon name="chevron-down" className="em-search-icon" />
      </button>
      <button
        type="button"
        className="em-search-btn"
        onClick={onClose}
        title="Close search (Esc)"
        aria-label="Close search"
      >
        <Icon name="x" className="em-search-icon" />
      </button>
    </div>
  );
}
