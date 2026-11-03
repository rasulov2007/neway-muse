import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useId, type HTMLAttributes } from 'react';
import { cn } from '../../lib/cn';
import { IconButton } from '../IconButton';
import { Select } from '../Select';
import {
  DEFAULT_PAGE_SIZES,
  formatNumber,
  formatPaginationRange,
  getPageCount,
} from './paginationUtils';

export interface PaginationProps extends Omit<HTMLAttributes<HTMLElement>, 'onChange'> {
  /** 1-based current page. */
  page: number;
  pageSize: number;
  /** Total number of rows across all pages. */
  total: number;
  onPageChange: (page: number) => void;
  /** Omit to hide the "Rows per page" select. */
  onPageSizeChange?: (pageSize: number) => void;
  pageSizes?: number[];
  /** Show the "1–25 of 377" text. DataTable renders it on the left instead. */
  showRange?: boolean;
}

/** Compact pager: rows-per-page select, range text, previous/next and a page indicator. */
export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
  pageSizes = DEFAULT_PAGE_SIZES,
  showRange = true,
  className,
  ...rest
}: PaginationProps) {
  const labelId = useId();
  const pageCount = getPageCount(pageSize, total);
  const sizes = pageSizes.includes(pageSize)
    ? pageSizes
    : [...pageSizes, pageSize].sort((a, b) => a - b);
  const sizeOptions = sizes.map((size) => ({ value: String(size), label: formatNumber(size) }));

  return (
    <nav
      aria-label="Pagination"
      className={cn('flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-nw-text-3', className)}
      {...rest}
    >
      {onPageSizeChange ? (
        <div className="flex items-center gap-2">
          <span id={labelId} className="whitespace-nowrap">
            Rows per page
          </span>
          <Select
            size="sm"
            aria-labelledby={labelId}
            options={sizeOptions}
            value={String(pageSize)}
            onValueChange={(value) => onPageSizeChange(Number(value))}
            className="w-18"
          />
        </div>
      ) : null}
      {showRange ? (
        <span className="tabular whitespace-nowrap">
          {formatPaginationRange(page, pageSize, total)}
        </span>
      ) : null}
      <div className="flex items-center gap-1">
        <IconButton
          size="sm"
          label="Previous page"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          <ChevronLeft />
        </IconButton>
        <span className="tabular px-1 whitespace-nowrap" aria-live="polite">
          Page {formatNumber(page)} of {formatNumber(pageCount)}
        </span>
        <IconButton
          size="sm"
          label="Next page"
          disabled={page >= pageCount}
          onClick={() => onPageChange(page + 1)}
        >
          <ChevronRight />
        </IconButton>
      </div>
    </nav>
  );
}
