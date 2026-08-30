import type { ReactNode } from 'react'

type Column<T> = {
  key: string
  header: string
  render: (row: T) => ReactNode
}

type ReferenceTableProps<T> = {
  rows: T[]
  columns: Array<Column<T>>
}

export function ReferenceTable<T>({ rows, columns }: ReferenceTableProps<T>) {
  return (
    <div className="not-prose overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
      <table className="min-w-full divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
        <thead className="bg-zinc-50 dark:bg-zinc-950">
          <tr>
            {columns.map((column) => (
              <th key={column.key} className="px-3 py-2 text-left font-semibold text-zinc-900 dark:text-zinc-100">
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {columns.map((column) => (
                <td key={column.key} className="px-3 py-2 align-top text-zinc-700 dark:text-zinc-300">
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
