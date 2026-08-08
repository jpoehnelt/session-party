import type { ReactNode } from "react";

export interface TableColumn<T> {
  key: string;
  header: ReactNode;
  render?: (row: T) => ReactNode;
}

export interface TableProps<T> {
  columns: TableColumn<T>[];
  rows: T[];
  /** Rendered centered in the body when `rows` is empty. */
  empty?: ReactNode;
  /** Stable row identity; falls back to array index. */
  rowKey?: (row: T, index: number) => string | number;
}

export function Table<T>({ columns, rows, empty, rowKey }: TableProps<T>) {
  return (
    <div className="overflow-x-auto rounded-card border border-line bg-surface shadow-card">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line bg-surface-muted/60">
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-ink-faint"
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.length === 0 ? (
            <tr>
              <td
                colSpan={columns.length}
                className="px-4 py-12 text-center text-sm text-ink-faint"
              >
                {empty ?? "Nothing here yet"}
              </td>
            </tr>
          ) : (
            rows.map((row, index) => (
              <tr
                key={rowKey ? rowKey(row, index) : index}
                className="transition-colors hover:bg-surface-muted/40"
              >
                {columns.map((column) => (
                  <td key={column.key} className="px-4 py-3 text-ink-secondary">
                    {column.render ? column.render(row) : defaultCell(row, column.key)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function defaultCell(row: unknown, key: string): ReactNode {
  const value = (row as Record<string, unknown>)[key];
  if (value == null) return null;
  return typeof value === "string" || typeof value === "number"
    ? value
    : String(value);
}
